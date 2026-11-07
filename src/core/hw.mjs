// 硬件调试 core（Round 3）：hw_server 探测/按需启动 + hw_scan / hw_program / debug_cores 同步 job。
//
// 设计约定（见 tools/vivado-mcp/SPEC_debug.md）：
//   - 一律通过既有 createJob + waitJob 执行 Vivado batch（kind='hw'|'debug'），job 目录与 job_list 兼容；
//   - TCL 侧参数全走环境变量（VMCP_JSON_OUT / VMCP_HW_SERVER_URL / VMCP_BIT_FILE / VMCP_HW_DEVICE /
//     VMCP_VERIFY / VMCP_DCP_FILE / VMCP_REPORT_DIR），结构化结果写 JSON 文件，Node 侧解析并判定；
//   - hw_server：仅本地地址按需 detached 启动（已有不杀、起不来给修复建议）；非本地地址不 spawn；
//   - hw_program 是唯一写操作：bit 必须显式绝对路径，绝不自动挑最新 bit；结果含 SHA256；
//   - debug_cores 纯只读：open_checkpoint 不打开工程、不占工程锁。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createProjectContext, resolveProject, resolveTclDir } from './config.mjs';
import { envError, McpError, argError } from './errors.mjs';
import { cancelJob, createJob, getJobStatus, listJobs, waitJob } from './jobs.mjs';
import { parseErrors, parseMarkers, parseWarningsSummary } from './parse.mjs';
import { currentRuns, designTop, parseXpr } from './project.mjs';
import { buildVivadoArgs, findVivadoCandidates } from './vivado.mjs';
import {
  executableInvocation,
  humanBytes,
  isProcessAlive,
  killProcessTree,
  listDirSafe,
  pathExists,
  readJsonFile,
  readTail,
  readTextFileOrNull,
  sha256,
  sleep,
  statOrNull,
  tailLines,
} from './util.mjs';

export const DEFAULT_HW_SERVER_URL = 'localhost:3121';
export const HW_SERVER_START_TIMEOUT_MS = 15000;
export const HW_SERVER_PROBE_TIMEOUT_MS = 1500;

export const HW_TCL_SCRIPTS = Object.freeze({
  scan: 'hw_scan.tcl',
  program: 'hw_program.tcl',
  debug: 'debug_cores.tcl',
});
export const HW_JOB_KIND = Object.freeze({ scan: 'hw', program: 'hw', debug: 'debug' });
export const HW_STAGE = Object.freeze({ scan: 'hw-scan', program: 'hw-program', debug: 'debug-cores' });
export const HW_TIMEOUT_DEFAULT = Object.freeze({ scan: 120, program: 180, debug: 240 });
export const HW_TIMEOUT_RANGE = Object.freeze({ scan: [30, 300], program: [60, 300], debug: [60, 300] });
export const HW_RESULT_FILE = 'hw_result.json';
const KNOWN_HW_SERVER_BATS = [
  'D:\\Xilinx\\Vivado\\2018.3\\bin\\hw_server.bat',
  'C:\\Xilinx\\Vivado\\2018.3\\bin\\hw_server.bat',
];

function clampTimeout(mode, value) {
  const [min, max] = HW_TIMEOUT_RANGE[mode];
  const n = Number(value);
  if (!Number.isFinite(n)) return HW_TIMEOUT_DEFAULT[mode];
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 解析 hw_server URL（支持 "localhost:3121" / "127.0.0.1:3121" / "tcp://host:port" / "[::1]:3121"） */
export function parseHwServerUrl(raw) {
  const url = String(raw || '').trim() || DEFAULT_HW_SERVER_URL;
  const withoutScheme = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '');
  let host = withoutScheme;
  let port = 3121;
  if (withoutScheme.startsWith('[')) {
    const end = withoutScheme.indexOf(']');
    if (end > 0) {
      host = withoutScheme.slice(1, end);
      const rest = withoutScheme.slice(end + 1);
      if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) port = Number(rest.slice(1));
    }
  } else {
    const idx = withoutScheme.lastIndexOf(':');
    if (idx > 0 && /^\d+$/.test(withoutScheme.slice(idx + 1))) {
      host = withoutScheme.slice(0, idx);
      port = Number(withoutScheme.slice(idx + 1));
    }
  }
  const normalizedHost = host.toLowerCase();
  const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(normalizedHost);
  return { url, host, port, isLocal };
}

/** TCP 探测（短超时，true=可连接） */
export function probeTcp(host, port, { timeoutMs = HW_SERVER_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 本地地址探测：localhost 同时尝试 IPv4/IPv6（hw_server 可能只监听 0.0.0.0） */
async function probeHwServer(parsed, { timeoutMs = HW_SERVER_PROBE_TIMEOUT_MS } = {}) {
  const hosts = parsed.isLocal && parsed.host === 'localhost' ? ['127.0.0.1', '::1'] : [parsed.host];
  for (const host of hosts) {
    if (await probeTcp(host, parsed.port, { timeoutMs })) return true;
  }
  return false;
}

/** 找 hw_server 可执行文件：env.VIVADO_HW_SERVER → Vivado bin 同目录 → 常见路径 → PATH */
export async function resolveHwServerBin({ env = process.env, vivadoBin = null } = {}) {
  const names = process.platform === 'win32' ? ['hw_server.bat', 'hw_server.exe'] : ['hw_server'];
  const candidates = [];
  if (env.VIVADO_HW_SERVER) candidates.push(env.VIVADO_HW_SERVER);
  if (vivadoBin) {
    for (const name of names) candidates.push(path.join(path.dirname(vivadoBin), name));
  }
  candidates.push(...KNOWN_HW_SERVER_BATS);
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) candidates.push(path.join(trimmed, name));
  }
  for (const candidate of candidates) {
    try {
      if (candidate && (await pathExists(candidate))) return path.resolve(candidate);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function findVivadoBinForHw(env) {
  const found = await findVivadoCandidates({ env });
  return found.results.length > 0 ? found.results[0].path : null;
}

/**
 * 确保 hw_server 可用：先 TCP 探测；本地不可达时 detached 启动 hw_server.bat，最多等 15s。
 * 已有 hw_server 不会被杀；只有“本次启动但失败”的进程树会被清理。
 *
 * @returns {Promise<{url:string,host:string,port:number,isLocal:boolean,connected:boolean,
 *   launchedByTool:boolean,pid?:number,hwServerBin?:string,skipped?:boolean,note?:string}>}
 */
export async function hwServerEnsure({
  url = DEFAULT_HW_SERVER_URL,
  env = process.env,
  vivadoBin = null,
  startTimeoutMs = HW_SERVER_START_TIMEOUT_MS,
  probeTimeoutMs = HW_SERVER_PROBE_TIMEOUT_MS,
  startPollMs = 300,
} = {}) {
  const parsed = parseHwServerUrl(url);

  // 测试/离线模式：跳过探测与启动（不接触真实 hw_server）
  if (String(env.VIVADO_MCP_HW_SERVER_MODE || '').toLowerCase() === 'skip') {
    return {
      ...parsed,
      connected: false,
      launchedByTool: false,
      skipped: true,
      note: 'VIVADO_MCP_HW_SERVER_MODE=skip：已跳过 hw_server 探测/启动（测试/离线模式）',
    };
  }

  if (await probeHwServer(parsed, { timeoutMs: probeTimeoutMs })) {
    return { ...parsed, connected: true, launchedByTool: false };
  }

  if (!parsed.isLocal) {
    throw envError(
      `无法连接 hw_server：${parsed.url}（非本地地址，本工具不会自动启动远端 hw_server）`,
      '确认远端主机已启动 hw_server、端口可达（防火墙/VPN）；或把 hw_server_url 指向本机 localhost:3121。',
      { code: 'HW_SERVER_UNAVAILABLE', url: parsed.url },
    );
  }

  const effectiveVivadoBin = vivadoBin || (await findVivadoBinForHw(env));
  const hwServerBin = await resolveHwServerBin({ env, vivadoBin: effectiveVivadoBin });
  if (!hwServerBin) {
    throw envError(
      '未找到 hw_server（hw_server.bat），无法启动硬件服务器',
      '确认 Vivado 安装完整（<Vivado>/bin/hw_server.bat 存在），把 Vivado bin 目录加入 PATH，或设置 VIVADO_HW_SERVER=<hw_server.bat 绝对路径>。',
      { code: 'HW_SERVER_UNAVAILABLE' },
    );
  }

  const invocation = executableInvocation(hwServerBin, []);
  let child = null;
  try {
    child = spawn(invocation.file, invocation.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: !!invocation.windowsVerbatimArguments,
      env,
    });
    child.unref();
  } catch (err) {
    throw envError(
      `启动 hw_server 失败：${err && err.message ? err.message : err}`,
      `检查 ${hwServerBin} 是否可执行、端口 3121 是否被占用。`,
      { code: 'HW_SERVER_UNAVAILABLE' },
    );
  }

  const deadline = Date.now() + Math.max(1000, startTimeoutMs);
  while (Date.now() < deadline) {
    await sleep(startPollMs);
    if (await probeHwServer(parsed, { timeoutMs: probeTimeoutMs })) {
      return {
        ...parsed,
        connected: true,
        launchedByTool: true,
        pid: child.pid || null,
        hwServerBin,
      };
    }
  }

  // 本次启动失败：清理我们拉起的进程树（已有 server 不会被走到这里）
  const pid = child.pid;
  if (pid && isProcessAlive(pid)) await killProcessTree(pid, { waitMs: 2000 }).catch(() => {});
  throw envError(
    `hw_server 启动后 ${Math.round(startTimeoutMs / 1000)}s 内仍无法连接 ${parsed.url}`,
    `手动排查：1) 直接运行 "${hwServerBin}" 看是否监听 TCP 3121；2) 检查端口占用/防火墙；3) 也可先手动启动 hw_server 后重试（已有实例本工具不会杀）。`,
    { code: 'HW_SERVER_UNAVAILABLE', url: parsed.url, hwServerBin },
  );
}

// ---------------------------------------------------------------------------
// TCL 标记 / JSON 解析
// ---------------------------------------------------------------------------

function numOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 解析 T1 的硬件调试标记行 */
export function parseHwMarkers(text) {
  const out = {
    scanDone: null,
    programDone: null,
    debugDone: null,
    resultJson: null,
    errors: [],
    finishes: [],
    lastFinish: null,
    markers: parseMarkers(text),
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let m = /^VMCP_HW_DONE\b(.*)$/.exec(line);
    if (m) {
      out.scanDone = {
        raw: line,
        targets: numOf((/(?:^|\s)targets=(\d+)/.exec(m[1]) || [])[1]),
        devices: numOf((/(?:^|\s)devices=(\d+)/.exec(m[1]) || [])[1]),
      };
      continue;
    }
    m = /^VMCP_PROGRAM_DONE\b(.*)$/.exec(line);
    if (m) {
      out.programDone = { raw: line, programmed: /(?:^|\s)programmed=(\d+)/.exec(m[1]) ? /(?:^|\s)programmed=(\d+)/.exec(m[1])[1] === '1' : null };
      continue;
    }
    m = /^VMCP_DEBUG_DONE\b(.*)$/.exec(line);
    if (m) {
      out.debugDone = { raw: line, cores: numOf((/(?:^|\s)cores=(\d+)/.exec(m[1]) || [])[1]) };
      continue;
    }
    m = /^VMCP_RESULT_JSON\b(.*)$/.exec(line);
    if (m) {
      out.resultJson = m[1].trim().replace(/^["']|["']$/g, '') || null;
      continue;
    }
    if (/^VMCP_ERROR\b/.test(line)) {
      out.errors.push(line.replace(/^VMCP_ERROR\s*/, '') || '未知硬件错误');
      continue;
    }
    m = /^VMCP_FINISH\b(.*)$/.exec(line);
    if (m) {
      const finish = { raw: line, ok: /ok/i.test(m[1]) && !/fail/i.test(m[1]) };
      out.finishes.push(finish);
      out.lastFinish = finish;
    }
  }
  return out;
}

function normalizeJsonErrors(json) {
  const out = [];
  const list = json && Array.isArray(json.errors) ? json.errors : [];
  for (const item of list) {
    if (item == null) continue;
    if (typeof item === 'string') out.push({ code: 'HW_ERROR', message: item });
    else out.push({ code: String(item.code || 'HW_ERROR'), message: String(item.message || item.msg || JSON.stringify(item)) });
  }
  if (json && json.ok === false && out.length === 0) {
    out.push({ code: 'HW_FAILED', message: String(json.message || '硬件操作失败（JSON ok=false，无 errors 详情）') });
  }
  return out;
}

function dedupeFailures(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const key = `${item.code || ''}:${item.message || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 读取 TCL 产出的结构化 JSON：优先 VMCP_RESULT_JSON 标记路径，其次 job 目录固定文件名 */
export async function readHwResultJson({ jobDir, markers, explicitPath = null }) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (markers && markers.resultJson) candidates.push(markers.resultJson);
  candidates.push(path.join(jobDir, HW_RESULT_FILE));
  const tried = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const abs = path.isAbsolute(candidate) ? candidate : path.join(jobDir, candidate);
    tried.push(abs);
    const json = await readJsonFile(abs, null);
    if (json && typeof json === 'object') return { json, jsonPath: abs, tried };
  }
  return { json: null, jsonPath: tried[0] || path.join(jobDir, HW_RESULT_FILE), tried };
}

/**
 * 组合一次硬件 job 的最终结果（runHw* 与 job_status 共用）。
 * @param {object} status getJobStatus 返回值
 * @param {{mode:'scan'|'program'|'debug'}} options
 */
export async function evaluateHwJob(status, { mode = null } = {}) {
  const effectiveMode = mode || status.meta?.mode || (status.stage === 'hw-program' ? 'program' : status.stage === 'debug-cores' ? 'debug' : 'scan');
  const logText = await readTail(status.logFile, 512 * 1024);
  const hwMarkers = parseHwMarkers(logText);
  const markers = hwMarkers.markers;
  const errorInfo = parseErrors(logText);
  const warningsSummary = parseWarningsSummary(logText);
  const active = status.status === 'running' || status.status === 'starting';

  const failures = [];
  if (active) {
    return {
      ...status,
      ok: null,
      mode: effectiveMode,
      hwMarkers,
      failures: [],
      summary: `硬件任务运行中（${effectiveMode}）`,
    };
  }

  const { json, jsonPath, tried } = await readHwResultJson({ jobDir: status.jobDir, markers: hwMarkers });
  const jobOk = status.status === 'done' && status.exitCode === 0;
  const jsonOk = !!(json && json.ok === true);
  const finishOk = hwMarkers.lastFinish ? hwMarkers.lastFinish.ok === true : true;
  const programmedOk = effectiveMode !== 'program' || (json && json.programmed === true);

  if (!jobOk) {
    failures.push({
      code: 'JOB_FAILED',
      message: `Vivado 进程状态=${status.status}${status.exitCode != null ? `，退出码=${status.exitCode}` : ''}`,
    });
    for (const failure of status.failures || []) failures.push(failure);
  }
  if (status.status === 'cancelled') failures.push({ code: 'CANCELLED', message: '硬件任务已被取消' });
  if (!finishOk) failures.push({ code: 'VMCP_FINISH_FAIL', message: `TCL 结束标记为失败：${hwMarkers.lastFinish.raw}` });
  for (const message of hwMarkers.errors) {
    // TCL 的 VMCP_ERROR 常写成 "<CODE>: <message>"（如 NO_HW_DEVICE: ...），提取错误码便于结构化归因/去重
    const coded = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(message);
    if (coded) failures.push({ code: coded[1], message: coded[2] });
    else failures.push({ code: 'VMCP_ERROR', message });
  }
  for (const item of normalizeJsonErrors(json)) failures.push(item);
  const expectedDone = { scan: 'VMCP_HW_DONE', program: 'VMCP_PROGRAM_DONE', debug: 'VMCP_DEBUG_DONE' }[effectiveMode];
  const hasDoneMarker = effectiveMode === 'scan' ? !!hwMarkers.scanDone : effectiveMode === 'program' ? !!hwMarkers.programDone : !!hwMarkers.debugDone;
  if (jobOk && !json) {
    failures.push({
      code: 'HW_RESULT_MISSING',
      message: `未找到 TCL 结构化结果 JSON（期望通过 VMCP_JSON_OUT 写到 ${jsonPath}；已尝试：${tried.join('；')}）`,
    });
  }
  if (jobOk && json && !hasDoneMarker) failures.push({ code: 'HW_MARKER_MISSING', message: `日志缺少完成标记 ${expectedDone}` });
  if (jobOk && json && !jsonOk) {
    // JSON.ok=false 已由 normalizeJsonErrors 追加失败原因；若仍为空再兜底
    if (!failures.some((f) => f.code !== 'JOB_FAILED')) failures.push({ code: 'HW_FAILED', message: '结构化 JSON 返回 ok=false' });
  }
  if (jobOk && json && !programmedOk) failures.push({ code: 'PROGRAM_FAILED', message: 'JSON 未确认 programmed=true（未能证明烧写成功）' });
  if (!jobOk) {
    for (const item of errorInfo.errors.slice(0, 10)) failures.push({ code: `LOG_${item.severity}`, message: item.message });
  }

  const ok = jobOk && jsonOk && programmedOk && finishOk && hwMarkers.errors.length === 0 && normalizeJsonErrors(json).length === 0;
  const elapsedMs = status.elapsedMs || 0;
  const bits = [];
  if (json && json.bitFile) bits.push(`bit=${json.bitFile}`);
  if (json && json.dcp) bits.push(`dcp=${json.dcp}`);

  return {
    ...status,
    ok,
    mode: effectiveMode,
    hwMarkers,
    json,
    jsonPath,
    failures: dedupeFailures(failures),
    errors: errorInfo.errors,
    warningsSummary,
    summary: buildHwSummary({ mode: effectiveMode, ok, json, hwMarkers, elapsedMs }),
  };
}

function buildHwSummary({ mode, ok, json, hwMarkers, elapsedMs }) {
  const seconds = Math.round((elapsedMs || 0) / 1000);
  if (!ok) return `硬件任务未通过（${mode}，${seconds}s）`;
  if (mode === 'scan') {
    const devices = json && Array.isArray(json.devices) ? json.devices.length : 0;
    const targets = json && Array.isArray(json.targets) ? json.targets.length : 0;
    return `硬件扫描成功：${targets} 个 target，${devices} 个设备${devices === 0 ? '（本机当前无 JTAG 板卡）' : ''}（${seconds}s）`;
  }
  if (mode === 'program') {
    return `烧写成功：${json && json.bitFile ? path.basename(json.bitFile) : 'bit'} → ${json && json.device ? json.device.name || json.device.part || '设备' : '设备'}（${seconds}s）`;
  }
  const cores = json && Array.isArray(json.cores) ? json.cores.length : 0;
  return `debug core 分析成功：${cores} 个 core${cores === 0 ? '（当前工程无 ILA/VIO）' : ''}（${seconds}s）`;
}

// ---------------------------------------------------------------------------
// 通用 job 执行
// ---------------------------------------------------------------------------

async function runHwMode({
  mode,
  projectDir,
  env = process.env,
  cwd = process.cwd(),
  timeoutSec = null,
  extraEnv = {},
  hwServer = null,
  banner = '',
  shouldAbort = null,
}) {
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const ctx = createProjectContext(resolved.projectDir, resolved.xprPath || null);
  const tclDir = resolveTclDir(env);
  const tclPath = path.join(tclDir, HW_TCL_SCRIPTS[mode]);
  if (!(await pathExists(tclPath))) {
    throw envError(
      `调试 TCL 脚本未就绪：${tclPath}`,
      `工具 vivado_${mode === 'scan' ? 'hw_scan' : mode === 'program' ? 'hw_program' : 'debug_cores'} 需要 T1 交付的 ${HW_TCL_SCRIPTS[mode]}（见 SPEC_debug §2）；联调前请等待 T1/TCL 就绪。`,
      { code: 'TCL_NOT_READY', script: tclPath },
    );
  }
  const vivadoBin = await findVivadoBinForHw(env);
  if (!vivadoBin) {
    throw envError('未找到 Vivado（vivado.bat），无法执行硬件调试任务', '设置环境变量 VIVADO_BIN=<Vivado bin 目录或 vivado.bat 绝对路径>。');
  }

  const waitTimeoutSec = clampTimeout(mode, timeoutSec);
  const jobHardTimeoutSec = waitTimeoutSec + 60;
  const hwServerInfo = hwServer
    ? {
        url: hwServer.url,
        connected: hwServer.connected,
        launchedByTool: !!hwServer.launchedByTool,
        skipped: !!hwServer.skipped,
        pid: hwServer.pid || null,
        note: hwServer.note || null,
      }
    : null;

  const created = await createJob({
    ctx,
    kind: HW_JOB_KIND[mode],
    stage: HW_STAGE[mode],
    stepsFactory: (jobDir) => {
      const logPath = path.join(jobDir, 'vivado.log');
      return [{ name: `vivado-${HW_STAGE[mode]}`, file: vivadoBin, args: buildVivadoArgs({ tclPath, logPath }), cwd: jobDir }];
    },
    env: (jobDir) => ({
      VIVADO_BIN: vivadoBin,
      VMCP_PROJECT_DIR: ctx.projectDir,
      ...(ctx.xprPath ? { VMCP_XPR: ctx.xprPath } : {}),
      VMCP_REPORT_DIR: jobDir,
      VMCP_JSON_OUT: path.join(jobDir, HW_RESULT_FILE),
      ...extraEnv,
    }),
    timeoutSec: jobHardTimeoutSec,
    reportDir: (jobDir) => jobDir,
    meta: {
      mode,
      stage: HW_STAGE[mode],
      tclPath,
      timeoutSec: waitTimeoutSec,
      hwServer: hwServerInfo,
      ...(extraEnv.VMCP_BIT_FILE ? { bitFile: extraEnv.VMCP_BIT_FILE } : {}),
      ...(extraEnv.VMCP_DCP_FILE ? { dcpFile: extraEnv.VMCP_DCP_FILE } : {}),
    },
    commandLabel: {
      file: vivadoBin,
      args: ['-mode', 'batch', '-notrace', '-nojournal', '-log', path.join('<job>', 'vivado.log'), '-source', tclPath],
    },
    banner,
  });

  let waited = await waitJob({
    projectDir: ctx.projectDir,
    jobId: created.job.id,
    timeoutMs: waitTimeoutSec * 1000,
    env,
    cwd,
    shouldAbort,
  });
  let timedOut = false;
  let aborted = !!waited.aborted;
  if ((waited.status === 'running' || waited.status === 'starting') && (waited.timedOut || aborted)) {
    timedOut = !!waited.timedOut;
    // 同步工具：超时/取消时终止本次 job，避免 hw 操作脱离调用方生命周期
    const cancelled = await cancelJob({ projectDir: ctx.projectDir, jobId: created.job.id, env, cwd }).catch(() => null);
    if (cancelled && cancelled.status) waited = cancelled.status;
    else waited = await getJobStatus({ projectDir: ctx.projectDir, jobId: created.job.id, env, cwd });
  }

  const evaluated = await evaluateHwJob(waited, { mode });
  const failures = [...evaluated.failures];
  if (timedOut) failures.push({ code: 'TIMEOUT', message: `等待超时（timeout_sec=${waitTimeoutSec}），已取消本次硬件任务` });
  if (aborted) failures.push({ code: 'CANCELLED', message: '调用方已取消本次硬件任务' });

  const base = {
    ok: evaluated.ok === true && failures.length === 0,
    mode,
    jobId: created.job.id,
    jobDir: created.jobDir,
    stage: HW_STAGE[mode],
    tclPath,
    hwServer: hwServerInfo,
    status: evaluated.status,
    exitCode: evaluated.exitCode,
    elapsedMs: evaluated.elapsedMs,
    timedOut,
    aborted,
    logFile: waited.logFile,
    vivadoLog: path.join(created.jobDir, 'vivado.log'),
    json: evaluated.json,
    jsonPath: evaluated.jsonPath,
    markers: evaluated.hwMarkers,
    warningsSummary: evaluated.warningsSummary,
    failures: dedupeFailures(failures),
    summary: failures.length > 0
      ? `硬件任务未通过（${mode}）：${failures.map((f) => f.message).slice(0, 4).join('；')}`
      : evaluated.summary,
  };
  return base;
}

// ---------------------------------------------------------------------------
// 三个对外 API
// ---------------------------------------------------------------------------

/** vivado_hw_scan：确保 hw_server 可用后扫描 JTAG targets/devices/ILA/VIO（只读） */
export async function runHwScan({
  projectDir,
  hwServerUrl = DEFAULT_HW_SERVER_URL,
  timeoutSec = null,
  env = process.env,
  cwd = process.cwd(),
  shouldAbort = null,
} = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const vivadoBin = await findVivadoBinForHw(env);
  const server = await hwServerEnsure({ url: hwServerUrl, env, vivadoBin });
  const banner = [
    '# Vivado MCP 硬件扫描（只读）',
    `# hw_server: ${server.url}（connected=${server.connected}${server.launchedByTool ? '，本工具启动' : ''}${server.skipped ? '，已跳过探测' : ''}）`,
    `# project: ${resolved.projectDir}`,
    '# 结果 JSON: <job>/hw_result.json（VMCP_JSON_OUT）',
  ].join('\n');
  const result = await runHwMode({
    mode: 'scan',
    projectDir: resolved.projectDir,
    env,
    cwd,
    timeoutSec: timeoutSec == null ? HW_TIMEOUT_DEFAULT.scan : timeoutSec,
    extraEnv: { VMCP_HW_SERVER_URL: server.url },
    hwServer: server,
    banner,
    shouldAbort,
  });
  const json = result.json || {};
  return {
    ...result,
    hwServer: { ...result.hwServer, connected: server.connected, launchedByTool: !!server.launchedByTool },
    targets: Array.isArray(json.targets) ? json.targets : [],
    devices: Array.isArray(json.devices) ? json.devices : [],
    ilas: Array.isArray(json.ilas) ? json.ilas : [],
    vios: Array.isArray(json.vios) ? json.vios : [],
  };
}

/** 校验 bit 文件：绝对路径 + 存在 + .bit 后缀；返回 {path,size,sha256} */
export async function validateBitFile(bitFile) {
  const raw = bitFile == null ? '' : String(bitFile).trim();
  if (!raw) {
    throw argError('缺少必填参数 bit_file（要烧写的 .bit 绝对路径）', '本工具不会自动选择最新 bit，必须显式传 bit 文件；例如 --bit <PROJECT_DIR>/<RUN_DIR>/<TOP>.bit 的绝对路径。');
  }
  if (!path.isAbsolute(raw)) {
    throw argError(`bit_file 必须是绝对路径：${raw}`, '传 .bit 文件的绝对路径（含盘符），避免误烧未知文件。');
  }
  const abs = path.resolve(raw);
  if (path.extname(abs).toLowerCase() !== '.bit') {
    throw argError(`bit_file 必须是 .bit 文件：${abs}`, '检查文件扩展名。');
  }
  const stat = await statOrNull(abs);
  if (!stat || !stat.isFile()) {
    throw envError(`bit 文件不存在：${abs}`, '先构建生成 bit（vivado_build_start stage=bitstream/full，或带 extra_xdc 的 full），再传绝对路径。', {
      code: 'BIT_NOT_FOUND',
      bitFile: abs,
    });
  }
  const content = await fs.promises.readFile(abs).catch(() => null);
  return { path: abs, size: stat.size, sha256: content ? sha256(content) : null, mtime: new Date(stat.mtimeMs).toISOString() };
}

/** vivado_hw_program：把显式指定的 bit 烧写到 JTAG 设备（写操作，含 SHA256 对账） */
export async function runHwProgram({
  bitFile,
  device = null,
  verify = true,
  projectDir,
  hwServerUrl = DEFAULT_HW_SERVER_URL,
  timeoutSec = null,
  env = process.env,
  cwd = process.cwd(),
  shouldAbort = null,
} = {}) {
  const bit = await validateBitFile(bitFile);
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const vivadoBin = await findVivadoBinForHw(env);
  const server = await hwServerEnsure({ url: hwServerUrl, env, vivadoBin });

  // 并发提示（不强制阻止）：同一工程有 build job 在跑时写明，避免误判硬件操作结果
  let concurrentBuild = null;
  try {
    const list = await listJobs({ projectDir: resolved.projectDir, limit: 20, env, cwd });
    const running = list.jobs.find((job) => job.kind === 'build' && (job.status === 'running' || job.status === 'starting'));
    if (running) concurrentBuild = { jobId: running.id, stage: running.stage, status: running.status };
  } catch {
    /* ignore */
  }

  const effectiveTimeout = clampTimeout('program', timeoutSec);
  const banner = [
    '# Vivado MCP 硬件烧写（写操作）',
    `# bit: ${bit.path}（${humanBytes(bit.size)}，sha256=${bit.sha256}）`,
    `# device: ${device || '（未指定：按 PART 自动匹配；多个设备会报错要求指定）'}`,
    `# verify: ${verify ? 'true' : 'false'}`,
    `# hw_server: ${server.url}（connected=${server.connected}${server.launchedByTool ? '，本工具启动' : ''}${server.skipped ? '，已跳过探测' : ''}）`,
    concurrentBuild ? `# 注意：同工程有 build job 在运行（${concurrentBuild.jobId}，stage=${concurrentBuild.stage}）` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const result = await runHwMode({
    mode: 'program',
    projectDir: resolved.projectDir,
    env,
    cwd,
    timeoutSec: effectiveTimeout,
    extraEnv: {
      VMCP_HW_SERVER_URL: server.url,
      VMCP_BIT_FILE: bit.path,
      ...(device ? { VMCP_HW_DEVICE: String(device) } : {}),
      VMCP_VERIFY: verify ? '1' : '0',
    },
    hwServer: server,
    banner,
    shouldAbort,
  });
  const json = result.json || {};
  const verifyInfo = json.verify && typeof json.verify === 'object'
    ? { requested: !!json.verify.requested, passed: json.verify.passed === true, detail: json.verify.detail || null }
    : { requested: !!verify, passed: null, detail: null };
  const warnings = [];
  if (concurrentBuild) warnings.push(`同工程有 build job 在运行（${concurrentBuild.jobId}），硬件操作结果可能与构建状态不一致`);
  // TCL 也会计算 bit SHA256（program JSON 里带 bitSha256）：与本机文件做一致性交叉校验
  const tclBitSha256 = json.bitSha256 ? String(json.bitSha256) : null;
  if (tclBitSha256 && bit.sha256 && tclBitSha256.toLowerCase() !== bit.sha256.toLowerCase()) {
    warnings.push(`TCL 报告的 bit SHA256 与本机文件不一致：tcl=${tclBitSha256} local=${bit.sha256}`);
  }
  return {
    ...result,
    programmed: json.programmed === true,
    device: json.device || null,
    bitFile: bit.path,
    bitSize: bit.size,
    bitSizeHuman: humanBytes(bit.size),
    bitSha256: bit.sha256,
    tclBitSha256,
    bitSha256Matched: tclBitSha256 ? tclBitSha256.toLowerCase() === String(bit.sha256).toLowerCase() : null,
    availableDevices: Array.isArray(json.availableDevices) ? json.availableDevices : [],
    programElapsedMs: Number.isFinite(Number(json.programElapsedMs)) ? Number(json.programElapsedMs) : null,
    verify: verifyInfo,
    hwServer: { ...result.hwServer, connected: server.connected, launchedByTool: !!server.launchedByTool },
    concurrentBuild,
    warnings,
  };
}

/**
 * 推导 debug_cores 的默认 dcp：current impl run + design top → <top>_routed.dcp；
 * 找不到时在 impl run 目录里兜底找唯一 *_routed.dcp。
 */
export async function resolveDebugDcp({ ctx, dcpFile = null } = {}) {
  if (dcpFile && String(dcpFile).trim()) {
    const raw = String(dcpFile).trim();
    if (!path.isAbsolute(raw)) {
      throw argError(`dcp_file 必须是绝对路径：${raw}`, '传 .dcp 文件的绝对路径。');
    }
    const abs = path.resolve(raw);
    if (path.extname(abs).toLowerCase() !== '.dcp') throw argError(`dcp_file 必须是 .dcp 文件：${abs}`, '检查文件扩展名。');
    const stat = await statOrNull(abs);
    if (!stat || !stat.isFile()) {
      throw envError(`dcp 文件不存在：${abs}`, '先构建生成 routed dcp，或显式传存在的 .dcp 绝对路径。', { code: 'DCP_NOT_FOUND', dcpFile: abs });
    }
    return { dcp: abs, source: 'explicit', top: null, implRun: null };
  }
  if (!ctx || !ctx.xprPath) {
    throw envError('未提供 dcp_file，且工程没有 .xpr 无法推导默认 dcp', '显式传 dcp_file，或设置 VIVADO_PROJECT_ROOT 指向工程根。', { code: 'DCP_NOT_FOUND' });
  }
  const parsed = parseXpr(ctx.xprPath, ctx);
  const impl = currentRuns(parsed).impl;
  if (!impl) {
    throw envError('工程没有 current impl run，无法推导默认 dcp', '先跑 vivado_build_start stage=impl/bitstream/full，或显式传 dcp_file。', { code: 'DCP_NOT_FOUND' });
  }
  const top = designTop(parsed) || null;
  const runDir = impl.dir || path.join(ctx.runsDir, impl.id);
  const primary = top ? path.join(runDir, `${top}_routed.dcp`) : null;
  if (primary && (await pathExists(primary))) return { dcp: primary, source: 'derived', top, implRun: impl.id };
  // 兜底：impl run 目录里唯一的 *_routed.dcp
  const entries = await listDirSafe(runDir);
  const routed = entries.filter((e) => e.isFile() && /_routed\.dcp$/i.test(e.name)).map((e) => path.join(runDir, e.name));
  if (routed.length === 1) return { dcp: routed[0], source: 'derived-fallback', top, implRun: impl.id };
  const hint = routed.length > 1
    ? `impl run 目录里有多个 routed dcp（${routed.map((p) => path.basename(p)).join(', ')}），请显式传 dcp_file。`
    : `未找到 ${top || '<top>'}_routed.dcp（impl run ${impl.id}）。先跑 vivado_build_start stage=impl/bitstream/full，或显式传 dcp_file。`;
  throw envError(`无法推导默认 dcp：${hint}`, hint, { code: 'DCP_NOT_FOUND', candidates: routed, implRun: impl.id, top });
}

/** vivado_debug_cores：open_checkpoint 分析 ILA/VIO（只读，不打开工程、不占工程锁） */
export async function runDebugCores({
  projectDir,
  dcpFile = null,
  includeNets = false,
  env = process.env,
  cwd = process.cwd(),
  shouldAbort = null,
} = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const ctx = createProjectContext(resolved.projectDir, resolved.xprPath || null);
  const resolvedDcp = await resolveDebugDcp({ ctx, dcpFile });
  const banner = [
    '# Vivado MCP debug core 分析（只读，不打开工程）',
    `# dcp: ${resolvedDcp.dcp}（来源 ${resolvedDcp.source}）`,
    `# include_nets: ${includeNets ? 'true' : 'false'}`,
    '# 结果 JSON: <job>/hw_result.json（VMCP_JSON_OUT）',
  ].join('\n');
  const result = await runHwMode({
    mode: 'debug',
    projectDir: resolved.projectDir,
    env,
    cwd,
    timeoutSec: HW_TIMEOUT_DEFAULT.debug,
    extraEnv: {
      VMCP_DCP_FILE: resolvedDcp.dcp,
      VMCP_INCLUDE_NETS: includeNets ? '1' : '0',
    },
    hwServer: null,
    banner,
    shouldAbort,
  });
  const json = result.json || {};
  const cores = Array.isArray(json.cores) ? json.cores : [];
  return {
    ...result,
    dcp: resolvedDcp.dcp,
    dcpSource: resolvedDcp.source,
    implRun: resolvedDcp.implRun,
    top: resolvedDcp.top,
    includeNets: !!includeNets,
    cores,
    note: cores.length === 0 ? '当前设计未发现 ILA/VIO debug core（本工程预期为空）' : null,
  };
}
