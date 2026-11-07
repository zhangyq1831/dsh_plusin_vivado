// 持久化异步 job：磁盘目录 + job.json（server 写）+ runner.json（job-runner 独占写）。
// 特性：detached 后台进程、MCP server 重启后仍可查询、同工程只允许一个构建 job、可取消进程树。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_ROOT, resolveNodeBin, resolveProject } from './config.mjs';
import { conflictError, envError } from './errors.mjs';
import { parseErrors, parseMarkers, parseProgress, parseSimResult, parseWarningsSummary } from './parse.mjs';
import {
  ensureDir,
  humanBytes,
  isProcessAlive,
  isWindows,
  isoNow,
  killProcessTree,
  listDirSafe,
  pathExists,
  randomHex,
  readJsonFile,
  readTail,
  readTextFileOrNull,
  resolvePath,
  sleep,
  statOrNull,
  tailLines,
  utcStamp,
  writeJsonAtomic,
} from './util.mjs';

const RUNNER_PATH = path.join(PACKAGE_ROOT, 'src', 'job-runner.mjs');
const ACTIVE_STATES = new Set(['starting', 'running']);

/** job id = <UTC 时间>-<stage>-<6hex> */
export function makeJobId(stage) {
  return `${utcStamp()}-${stage}-${randomHex(3)}`;
}

/** 列出工程下所有 job 目录（按名字倒序 = 时间倒序） */
export async function listJobDirs(ctx) {
  const entries = await listDirSafe(ctx.jobsDir);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, dir: path.join(ctx.jobsDir, e.name) }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

async function loadRunnerState(jobDir) {
  return await readJsonFile(path.join(jobDir, 'runner.json'), null);
}

/** job 是否仍活跃（只读 runner.json + pid，不解析日志，用于并发保护） */
async function isJobActive(jobDir) {
  const job = await readJsonFile(path.join(jobDir, 'job.json'), null);
  if (!job) return false;
  const runner = await loadRunnerState(jobDir);
  if (runner && runner.status && !ACTIVE_STATES.has(runner.status)) return false;
  const runnerPid = runner?.runnerPid || job.launchPid || null;
  const childPid = runner?.childPid || null;
  if (runnerPid && isProcessAlive(runnerPid)) return true;
  if (childPid && isProcessAlive(childPid)) return true;
  // runner 还没开始写状态：20s 内视为 starting
  if (!runner && job.createdAt && Date.now() - Date.parse(job.createdAt) < 20000) return true;
  return false;
}

/** 同一工程同时只允许一个构建 job（仿真不占工程锁，允许并行） */
export async function assertNoRunningBuildJob(ctx) {
  const dirs = await listJobDirs(ctx);
  for (const item of dirs.slice(0, 32)) {
    const job = await readJsonFile(path.join(item.dir, 'job.json'), null);
    if (!job || job.kind !== 'build') continue;
    if (await isJobActive(item.dir)) {
      throw conflictError(
        `该工程已有构建 job 在运行：${job.id}（stage=${job.stage}）`,
        `先用 vivado_job_status / vivado_job_wait 等待它结束，或 vivado_job_cancel 取消后再启动新构建。`,
        { jobId: job.id },
      );
    }
  }
}

/**
 * 启动后台 job。
 * @param {object} options
 * @param {object} options.ctx 工程上下文
 * @param {'build'|'sim'} options.kind
 * @param {string} options.stage
 * @param {Array<{name:string,file:string,args:string[],cwd?:string,env?:object}>} [options.steps]
 * @param {(jobDir:string, jobId:string)=>Promise<Array>} [options.stepsFactory] 需要 job 目录/ID 才能算参数时使用
 * @param {object} [options.env] 注入到每个步骤的环境变量
 * @param {number} [options.timeoutSec]
 * @param {string} [options.reportDir] 若为函数则接收 (jobDir, jobId)
 * @param {object} [options.meta]
 * @param {object} [options.restoreXpr] {xprPath, backupPath}
 * @param {string} [options.banner] 写进 run.log 的第一段说明
 */
export async function createJob({
  ctx,
  kind,
  stage,
  steps = null,
  stepsFactory = null,
  env = {},
  timeoutSec = 900,
  reportDir = null,
  meta = {},
  restoreXpr = null,
  banner = '',
  commandLabel = null,
}) {
  if (kind === 'build') await assertNoRunningBuildJob(ctx);
  await ensureDir(ctx.jobsDir);

  let id = makeJobId(stage);
  let jobDir = path.join(ctx.jobsDir, id);
  for (let attempt = 0; attempt < 3 && (await pathExists(jobDir)); attempt++) {
    id = makeJobId(stage);
    jobDir = path.join(ctx.jobsDir, id);
  }
  await ensureDir(jobDir);

  const finalSteps = stepsFactory ? await stepsFactory(jobDir, id) : steps;
  if (!Array.isArray(finalSteps) || finalSteps.length === 0) {
    throw envError('job 没有可执行步骤（steps/stepsFactory 均为空）');
  }
  const logFile = path.join(jobDir, 'run.log');
  const resolvedReportDir = typeof reportDir === 'function' ? reportDir(jobDir, id) : reportDir || path.join(jobDir, 'reports');
  // env 可以是函数：需要 jobId/jobDir 才能确定的变量（如 VMCP_REPORT_DIR）在创建时展开
  const resolvedEnv = typeof env === 'function' ? await env(jobDir, id) : env;
  const job = {
    id,
    kind,
    stage,
    status: 'starting',
    projectDir: ctx.projectDir,
    xprPath: ctx.xprPath,
    command: commandLabel || { file: finalSteps[0].file, args: finalSteps[0].args || [] },
    steps: finalSteps.map((s) => ({ name: s.name, file: s.file, args: s.args || [], cwd: s.cwd || jobDir, env: s.env || {} })),
    env: {
      VIVADO_PROJECT_ROOT: ctx.projectDir,
      ...(resolvedEnv || {}),
    },
    startedAt: isoNow(),
    createdAt: isoNow(),
    endedAt: null,
    exitCode: null,
    launchPid: null,
    timeoutSec,
    logFile,
    reportDir: resolvedReportDir,
    workDir: jobDir,
    markers: {},
    failures: [],
    restoreXpr: restoreXpr || null,
    meta,
    tool: { name: 'vivado-mcp', version: '0.1.0' },
  };
  await writeJsonAtomic(path.join(jobDir, 'job.json'), job);

  if (banner) {
    await writeBanner(logFile, banner);
  }

  const nodeBin = resolveNodeBin();
  let child;
  try {
    child = spawn(nodeBin, [RUNNER_PATH, jobDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        ...job.env,
        VMCP_JOB_DIR: jobDir,
      },
    });
    child.unref();
  } catch (err) {
    await writeJsonAtomic(path.join(jobDir, 'job.json'), {
      ...job,
      status: 'failed',
      endedAt: isoNow(),
      failures: [{ code: 'RUNNER_SPAWN_FAILED', message: `无法启动 job runner：${err && err.message ? err.message : err}` }],
    });
    throw envError(`启动后台 job 失败：${err && err.message ? err.message : err}`, `检查 node 路径（${nodeBin}）与 job runner 文件（${RUNNER_PATH}）是否存在。`);
  }

  const launchPid = child.pid || null;
  job.launchPid = launchPid;
  await writeJsonAtomic(path.join(jobDir, 'job.json'), job);
  return { job: { ...job, launchPid }, jobDir };
}

async function writeBanner(logFile, banner) {
  const fsPromises = await import('node:fs/promises');
  await fsPromises.appendFile(logFile, `${banner.trim()}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 定位 job 目录：优先 project_dir / env，再尝试 cwd；支持完整 id 或唯一前缀 */
export async function locateJob({ projectDir, jobId, env = process.env, cwd = process.cwd() } = {}) {
  const id = String(jobId || '').trim();
  if (!id) throw envError('缺少 job_id', '传入 vivado_build_start / vivado_sim_start 返回的 job_id。');
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const ctx = { projectDir: resolved.projectDir, jobsDir: path.join(resolved.projectDir, '.vivado-mcp', 'jobs') };
  const entries = await listDirSafe(ctx.jobsDir);
  if (entries.length === 0) {
    throw envError(`工程下没有任何 job：${ctx.jobsDir}`, '先调用 vivado_build_start 或 vivado_sim_start 创建 job。');
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const exact = names.find((n) => n === id);
  if (exact) return { id: exact, jobDir: path.join(ctx.jobsDir, exact) };
  const matches = names.filter((n) => n.startsWith(id));
  if (matches.length === 1) return { id: matches[0], jobDir: path.join(ctx.jobsDir, matches[0]) };
  if (matches.length > 1) {
    throw envError(
      `job_id 前缀 ${id} 匹配到多个 job：${matches.slice(0, 5).join(', ')}`,
      '请使用完整 job_id。',
    );
  }
  const recent = names.sort((a, b) => b.localeCompare(a)).slice(0, 8);
  throw envError(
    `未找到 job：${id}`,
    `该工程最近的 job：${recent.join(', ') || '（无）'}；也可用 vivado_job_list 查看。`,
  );
}

/** 计算 job 状态（从磁盘恢复；server 重启后同样可用） */
export async function getJobStatus({ projectDir, jobId, env = process.env, cwd = process.cwd() } = {}) {
  const located = await locateJob({ projectDir, jobId, env, cwd });
  const job = await readJsonFile(path.join(located.jobDir, 'job.json'), null);
  if (!job) throw envError(`job 目录损坏（缺少 job.json）：${located.jobDir}`, '可删除该 job 目录后重新启动。');
  const runner = await loadRunnerState(located.jobDir);
  const runnerAlive = runner?.runnerPid ? isProcessAlive(runner.runnerPid) : false;
  const childAlive = runner?.childPid ? isProcessAlive(runner.childPid) : false;

  let status;
  let failure = null;
  const jobIsTerminal = ['done', 'failed', 'cancelled'].includes(job.status);
  if (jobIsTerminal) {
    // job.json 被 server 写入过终态（例如取消、runner 启动失败）时以它为准
    status = job.status;
  } else if (runner && runner.status) {
    status = runner.status;
  } else if (!runner) {
    const ageMs = job.createdAt ? Date.now() - Date.parse(job.createdAt) : 0;
    status = ageMs > 30000 ? 'failed' : 'starting';
    if (status === 'failed') {
      failure = { code: 'RUNNER_NOT_STARTED', message: 'job runner 未能在 30s 内启动，可能 node 路径不可用或 runner 脚本缺失' };
    }
  } else if (runnerAlive || childAlive) {
    status = 'running';
  } else {
    status = 'failed';
    failure = { code: 'RUNNER_DIED', message: 'job runner 已退出但未写入终态（进程可能被外部结束）' };
  }

  const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : null;
  const endedAt = runner?.endedAt || null;
  const elapsedMs = startedAtMs ? (endedAt ? Date.parse(endedAt) - startedAtMs : Date.now() - startedAtMs) : 0;

  // 日志尾部解析（最多 256KB，job 日志通常几 MB 以内）
  const logTail = await readTail(job.logFile, 256 * 1024);
  const markers = parseMarkers(logTail);
  const progressInfo = parseProgress(logTail);
  const errorInfo = parseErrors(logTail);
  const warningsSummary = parseWarningsSummary(logTail);

  // 进度：终态成功 = 100；否则按 stage 使用完成标记推导（避免“综合完成标记 100%”在 full 构建中误报 100%）
  let percent = progressInfo.percent;
  let progressNote = '';
  if (status === 'done') {
    percent = 100;
  } else if (job.stage === 'full') {
    if (markers.implDone) {
      percent = 90;
      progressNote = '实现完成，正在生成比特流';
    } else if (markers.synthDone) {
      percent = 55;
      progressNote = '综合完成，正在实现';
    } else if (percent != null) {
      percent = Math.min(percent, 50);
    }
  } else if (job.stage === 'synth') {
    if (markers.synthDone) percent = 100;
  } else if (job.stage === 'impl' || job.stage === 'bitstream') {
    if (markers.implDone) percent = job.stage === 'impl' ? 100 : 90;
    else if (percent != null) percent = Math.min(percent, 85);
  } else if (percent != null) {
    percent = Math.min(percent, 99);
  }

  // 产物
  const artifacts = {
    log: job.logFile,
    vivadoLog: (await pathExists(path.join(located.jobDir, 'vivado.log'))) ? path.join(located.jobDir, 'vivado.log') : null,
    reportDir: (await pathExists(job.reportDir)) ? job.reportDir : null,
    reports: [],
    bitstream: null,
    workDir: located.jobDir,
  };
  if (artifacts.reportDir) {
    for (const entry of await listDirSafe(artifacts.reportDir)) {
      if (!entry.isFile()) continue;
      const p = path.join(artifacts.reportDir, entry.name);
      const stat = await statOrNull(p);
      artifacts.reports.push({ name: entry.name, path: p, size: stat ? stat.size : 0, sizeHuman: humanBytes(stat ? stat.size : 0) });
    }
  }
  if (markers.bitstreamOk?.path) {
    const bitPath = resolvePath(markers.bitstreamOk.path, job.projectDir);
    const stat = await statOrNull(bitPath);
    artifacts.bitstream = {
      path: bitPath,
      exists: !!stat,
      size: stat ? stat.size : 0,
      sizeHuman: humanBytes(stat ? stat.size : 0),
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
    };
  }
  // 报告路径也可能只在 VMCP_REPORT 里
  for (const reportPath of markers.reports) {
    const abs = resolvePath(reportPath, job.projectDir);
    if (artifacts.reports.some((r) => r.path === abs)) continue;
    const stat = await statOrNull(abs);
    if (stat) artifacts.reports.push({ name: path.basename(abs), path: abs, size: stat.size, sizeHuman: humanBytes(stat.size) });
  }

  const failures = [];
  if (failure) failures.push(failure);
  if (status === 'failed' || status === 'cancelled') {
    for (const message of markers.errors) failures.push({ code: 'VMCP_ERROR', message });
    for (const item of errorInfo.errors.slice(0, 10)) failures.push({ code: 'LOG_ERROR', message: item.message });
    if (runner?.timedOut) failures.push({ code: 'TIMEOUT', message: `job 超时（timeout_sec=${job.timeoutSec}）` });
    if (runner?.exitCode != null && runner.exitCode !== 0) {
      failures.push({ code: 'EXIT_CODE', message: `进程退出码 ${runner.exitCode}` });
    }
  }

  const statusObj = {
    id: job.id,
    kind: job.kind,
    stage: job.stage,
    status,
    projectDir: job.projectDir,
    xprPath: job.xprPath || null,
    startedAt: job.startedAt,
    endedAt,
    elapsedMs,
    exitCode: runner?.exitCode ?? null,
    pid: runner?.childPid || job.launchPid || null,
    runnerPid: runner?.runnerPid || job.launchPid || null,
    runnerAlive,
    currentStep: runner?.currentStep || (runner?.steps?.length ? runner.steps[runner.steps.length - 1]?.name : null),
    steps: runner?.steps || [],
    progress: {
      percent: percent != null ? Math.min(100, Math.round(percent)) : null,
      stage: progressInfo.stage,
      source: percent != null ? (progressInfo.source || 'marker') : null,
      note: progressNote || undefined,
    },
    markers: {
      synthDone: markers.synthDone,
      implDone: markers.implDone,
      bitstreamOk: markers.bitstreamOk,
      reports: markers.reports,
      errors: markers.errors,
      lastFinish: markers.lastFinish,
    },
    errors: errorInfo.errors,
    criticalWarnings: errorInfo.criticalWarnings,
    warningsSummary,
    failures,
    artifacts,
    logFile: job.logFile,
    command: job.command,
    timeoutSec: job.timeoutSec,
    restoreXpr: job.restoreXpr || null,
    xprRestored: runner?.xprRestored || job.xprRestored || null,
    meta: job.meta || {},
    jobDir: located.jobDir,
  };

  // 终态回写 job.json（SPEC §4.3：job.json 含 status/exitCode/endedAt/pid/markers），便于 server 重启后与证据留存。
  // 只有 server 写 job.json；runner 已结束，不存在并发写。
  if (['done', 'failed', 'cancelled'].includes(status) && job.status !== status) {
    try {
      await writeJsonAtomic(path.join(located.jobDir, 'job.json'), {
        ...job,
        status,
        endedAt: endedAt || isoNow(),
        exitCode: runner?.exitCode ?? job.exitCode ?? null,
        pid: statusObj.pid,
        progressPercent: statusObj.progress.percent,
        markers: statusObj.markers,
        failures: failures.length > 0 ? failures : job.failures || [],
        xprRestored: statusObj.xprRestored,
        updatedAt: isoNow(),
      });
    } catch {
      /* 回写失败不影响查询结果 */
    }
  }
  return statusObj;
}

/** 等待 job 结束（轮询 status），超时返回 running + 当前进度 */
export async function waitJob({
  projectDir,
  jobId,
  timeoutMs = 120000,
  env = process.env,
  cwd = process.cwd(),
  pollMs = 500,
  shouldAbort = null,
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(1000, timeoutMs);
  let last = null;
  while (true) {
    last = await getJobStatus({ projectDir, jobId, env, cwd });
    if (!ACTIVE_STATES.has(last.status) && last.status !== 'starting') return { ...last, waitedMs: Date.now() - startedAt, timedOut: false, aborted: false };
    if (shouldAbort && shouldAbort()) return { ...last, waitedMs: Date.now() - startedAt, timedOut: false, aborted: true };
    if (Date.now() >= deadline) return { ...last, waitedMs: Date.now() - startedAt, timedOut: true, aborted: false };
    await sleep(pollMs);
  }
}

/** 读取 job 日志尾部 */
export async function getJobOutput({ projectDir, jobId, lines = 80, env = process.env, cwd = process.cwd() } = {}) {
  const located = await locateJob({ projectDir, jobId, env, cwd });
  const job = await readJsonFile(path.join(located.jobDir, 'job.json'), null);
  if (!job) throw envError(`job 目录损坏（缺少 job.json）：${located.jobDir}`);
  const requested = Math.max(1, Math.min(Number(lines) || 80, 400));
  const logPath = job.logFile;
  const stat = await statOrNull(logPath);
  const maxBytes = 512 * 1024;
  const readMoreThanNeeded = Math.min(maxBytes, Math.max(64 * 1024, requested * 400));
  const tail = await readTail(logPath, readMoreThanNeeded);
  const allLines = tailLines(tail, requested);
  const note = requested < Number(lines) ? `lines 超过上限，已截断为 ${requested} 行` : '';
  return {
    id: job.id,
    status: 'see job status',
    logFile: logPath,
    logSize: stat ? stat.size : 0,
    logSizeHuman: humanBytes(stat ? stat.size : 0),
    linesRequested: Number(lines) || 80,
    lines: allLines,
    truncated: allLines.length >= requested,
    note,
  };
}

/** 取消 job：杀整棵进程树 + 落盘 cancelled 终态 */
export async function cancelJob({ projectDir, jobId, env = process.env, cwd = process.cwd() } = {}) {
  const located = await locateJob({ projectDir, jobId, env, cwd });
  const jobPath = path.join(located.jobDir, 'job.json');
  const job = await readJsonFile(jobPath, null);
  if (!job) throw envError(`job 目录损坏（缺少 job.json）：${located.jobDir}`);
  const runner = await loadRunnerState(located.jobDir);
  const statusBefore = runner?.status || job.status;
  if (statusBefore && !ACTIVE_STATES.has(statusBefore)) {
    return { cancelled: false, alreadyTerminal: true, status: await getJobStatus({ projectDir: job.projectDir, jobId: located.id, env, cwd }) };
  }
  // 取消标记（供 runner 参考，也便于人工排查）
  await writeJsonAtomic(path.join(located.jobDir, 'cancel.requested'), { requestedAt: isoNow(), by: 'vivado-mcp' }).catch(() => {});

  const pids = [];
  if (runner?.childPid) pids.push(runner.childPid);
  if (runner?.runnerPid) pids.push(runner.runnerPid);
  if (job.launchPid) pids.push(job.launchPid);
  const uniquePids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const killResults = [];
  for (const pid of uniquePids) {
    killResults.push(await killProcessTree(pid, { waitMs: 4000 }).catch((err) => ({ killed: false, pid, error: String(err) })));
  }
  // 再等一小会儿，确认进程树确实退出
  await sleep(200);
  const stillAlive = uniquePids.filter((p) => isProcessAlive(p));

  // 写终态（server 拥有 job.json；runner 已被杀，不会再写）
  const endedAt = isoNow();
  await writeJsonAtomic(jobPath, {
    ...job,
    status: 'cancelled',
    endedAt,
    exitCode: runner?.exitCode ?? null,
    failures: [{ code: 'CANCELLED', message: '用户取消（进程树已被终止）' }],
  });
  return {
    cancelled: stillAlive.length === 0,
    alreadyTerminal: false,
    stillAlive,
    killResults,
    status: await getJobStatus({ projectDir: job.projectDir, jobId: located.id, env, cwd }),
  };
}

/** 最近 jobs 列表（扫描磁盘全部目录，容错跳过非本工具格式目录；按 startedAt/目录名倒序） */
export async function listJobs({ projectDir, limit = 10, env = process.env, cwd = process.cwd() } = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd, requireXpr: false });
  const jobsDir = path.join(resolved.projectDir, '.vivado-mcp', 'jobs');
  const entries = await listDirSafe(jobsDir);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => ({ id: e.name, dir: path.join(jobsDir, e.name) }));
  const allJobs = [];
  const ignoredDirs = [];
  for (const item of dirs) {
    const job = await readJsonFile(path.join(item.dir, 'job.json'), null);
    // 容错：跳过 T1 手工证据目录等非本工具格式的目录（无 job.json）
    if (!job || typeof job !== 'object' || !job.id) {
      ignoredDirs.push(item.id);
      continue;
    }
    const runner = await loadRunnerState(item.dir);
    const active = await isJobActive(item.dir);
    let status = runner?.status || job.status || 'unknown';
    if (active && (status === 'starting' || status === 'running')) status = status === 'starting' ? 'starting' : 'running';
    if (!active && ACTIVE_STATES.has(status)) status = 'failed';
    const tail = await readTail(job.logFile || path.join(item.dir, 'run.log'), 32 * 1024);
    const markers = parseMarkers(tail);
    const progressInfo = parseProgress(tail);
    let percent = progressInfo.percent;
    if (status === 'done') percent = 100;
    else if (job.stage === 'full' && markers.implDone) percent = 90;
    else if (job.stage === 'full' && markers.synthDone) percent = 55;
    const startedAt = job.startedAt || job.createdAt || null;
    const startedAtMs = startedAt ? Date.parse(startedAt) : 0;
    allJobs.push({
      id: job.id,
      kind: job.kind,
      stage: job.stage,
      status,
      startedAt,
      startedAtMs,
      endedAt: runner?.endedAt || job.endedAt || null,
      elapsedMs: startedAt ? (runner?.endedAt ? Date.parse(runner.endedAt) - Date.parse(startedAt) : Date.now() - Date.parse(startedAt)) : 0,
      exitCode: runner?.exitCode ?? job.exitCode ?? null,
      progressPercent: percent,
      ok: status === 'done' ? undefined : false,
      hasSynthDone: !!markers.synthDone,
      hasImplDone: !!markers.implDone,
      hasBitstream: !!markers.bitstreamOk,
      simPassCount: job.kind === 'sim' ? parseSimResult(tail).passCount : undefined,
      xprRestored: runner?.xprRestored?.restoredAt || job.xprRestored?.restoredAt || null,
      jobDir: item.dir,
    });
  }
  // 按开始时间倒序（同时间按 id 倒序）；非本工具格式目录已在上面跳过
  allJobs.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0) || b.id.localeCompare(a.id));
  const max = Math.max(1, Math.min(Number(limit) || 10, 50));
  const limited = allJobs.slice(0, max);
  const notes = [];
  if (limited.length < allJobs.length) notes.push(`共 ${allJobs.length} 个 job，仅返回最近 ${limited.length} 个（limit=${max}）`);
  if (ignoredDirs.length > 0) notes.push(`已忽略 ${ignoredDirs.length} 个非本工具格式目录（无 job.json）：${ignoredDirs.slice(0, 6).join(', ')}${ignoredDirs.length > 6 ? ' …' : ''}`);
  return {
    projectDir: resolved.projectDir,
    jobsDir,
    count: allJobs.length,
    returned: limited.length,
    truncated: limited.length < allJobs.length,
    ignoredDirs,
    note: notes.join('；'),
    jobs: limited,
  };
}

export { isJobActive };
