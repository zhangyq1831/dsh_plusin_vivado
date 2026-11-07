// 构建（synth / impl / bitstream / full）：调用 T1 的 tcl/**，异步 job + xpr 备份/恢复 + 结果判定。
// TCL 契约见 SPEC §3.1：-mode batch -notrace -nojournal -log <job>/vivado.log -source <tcl>/<script>.tcl
// 参数通过 VMCP_* 环境变量传递。
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_DIR_NAME,
  createProjectContext,
  RUNTIME_DIR_NAME,
  resolveProject,
  resolveTclDir,
} from './config.mjs';
import { conflictError, envError } from './errors.mjs';
import { createJob, getJobStatus, waitJob } from './jobs.mjs';
import { explainError, markersSatisfied, parseErrors, parseMarkers, parseProgress, parseVivadoErrors, parseWarningsSummary, pickDrcErrors } from './parse.mjs';
import { currentRuns, designFileSet, extractModules, parseXpr } from './project.mjs';
import {
  buildVivadoArgs,
  checkProjectAvailability,
  findVivadoCandidates,
  inspectTclScripts,
} from './vivado.mjs';
import {
  ensureDir,
  humanBytes,
  isoNow,
  listDirSafe,
  pathExists,
  randomHex,
  readTextFile,
  readTail,
  sha256,
  statOrNull,
  utcStamp,
} from './util.mjs';

export const BUILD_STAGES = ['synth', 'impl', 'bitstream', 'full'];
export const STAGE_TCL_SCRIPT = {
  synth: 'synth.tcl',
  impl: 'bitgen.tcl',
  bitstream: 'bitgen.tcl',
  full: 'build.tcl',
};
export const DEFAULT_BUILD_TIMEOUTS = {
  synth: 1800,
  impl: 3600,
  bitstream: 3600,
  full: 7200,
};
export const DEFAULT_JOBS = 4;

export function normalizeStage(stage) {
  const s = String(stage || '').trim().toLowerCase();
  if (!BUILD_STAGES.includes(s)) {
    throw envError(
      `非法的 stage：${stage}`,
      `stage 必须是 ${BUILD_STAGES.join(' | ')} 之一（synth=只综合；impl=实现（不含比特流要求）；bitstream=实现+比特流；full=综合+实现+比特流）。`,
    );
  }
  return s;
}

function normalizeJobs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_JOBS;
  return Math.max(1, Math.min(32, Math.round(n)));
}

/** 备份 xpr 到 .vivado-mcp/backup/<utc>-<6hex>/，返回备份信息 */
export async function backupXpr(ctx) {
  if (!ctx.xprPath) throw envError('工程没有 .xpr 文件，无法备份', '确认 project_dir 指向 Vivado 工程根。');
  const xprStat = await statOrNull(ctx.xprPath);
  if (!xprStat) throw envError(`工程文件不存在，无法备份：${ctx.xprPath}`);
  const backupDir = path.join(ctx.backupDir, `${utcStamp()}-${randomHex(3)}`);
  await ensureDir(backupDir);
  const backupPath = path.join(backupDir, path.basename(ctx.xprPath));
  const content = await fs.promises.readFile(ctx.xprPath);
  await fs.promises.writeFile(backupPath, content);
  const info = {
    xprPath: ctx.xprPath,
    backupDir,
    backupPath,
    size: content.length,
    sha256: sha256(content),
    createdAt: isoNow(),
    runtimeDirName: RUNTIME_DIR_NAME,
    backupDirName: BACKUP_DIR_NAME,
  };
  await fs.promises.writeFile(
    path.join(backupDir, 'backup.json'),
    JSON.stringify({ ...info, originalMtime: new Date(xprStat.mtimeMs).toISOString() }, null, 2) + '\n',
  );
  return info;
}

/** 设计源里是否存在 module（top 覆盖时做软校验） */
async function designHasModule(ctx, parsed, moduleName) {
  const designSet = designFileSet(parsed);
  if (!designSet) return false;
  const target = String(moduleName || '').toLowerCase();
  for (const file of designSet.files) {
    const text = await fs.promises.readFile(file.path, 'utf8').catch(() => '');
    if (extractModules(text).some((m) => m.toLowerCase() === target)) return true;
  }
  return false;
}

/**
 * 启动构建 job（异步，立即返回 job_id）。
 * @returns {Promise<{job:object, ctx:object, backup:object, command:object, reportDir:string, tcl:string}>}
 */
export async function startBuildJob({
  projectDir,
  stage = 'full',
  top = null,
  run = null,
  synthRun = null,
  implRun = null,
  jobs = DEFAULT_JOBS,
  extraXdc = null,
  timeoutSec = null,
  env = process.env,
  cwd = process.cwd(),
  allowExternalVivado = false,
} = {}) {
  const normalizedStage = normalizeStage(stage);
  const resolved = await resolveProject({ projectDir, env, cwd });
  const ctx = createProjectContext(resolved.projectDir, resolved.xprPath);

  const tclDir = resolveTclDir(env);
  const tclScripts = await inspectTclScripts(tclDir);
  if (!tclScripts.complete) {
    throw envError(
      `TCL 构建脚本未就绪（${tclDir}）：缺少 ${tclScripts.missing.join(', ')}`,
      'tcl/** 由 T1 负责交付（synth.tcl / bitgen.tcl / build.tcl / lib_flow.tcl）。联调前可先跑 vivado_doctor / vivado_project_info / 仿真；也可用 VIVADO_MCP_TCL_DIR 指向含脚本的目录。',
    );
  }
  const tclPath = path.join(tclDir, STAGE_TCL_SCRIPT[normalizedStage]);

  const found = await findVivadoCandidates({ env });
  if (found.results.length === 0) {
    throw envError(
      '未找到 Vivado（vivado.bat），无法执行构建',
      '设置环境变量 VIVADO_BIN=<Vivado bin 目录或 vivado.bat 绝对路径>，或把 Vivado bin 目录加入 PATH。',
    );
  }
  const vivadoBin = found.results[0].path;

  const availability = await checkProjectAvailability({ projectDir: ctx.projectDir, allowExternalVivado, env });
  if (!availability.ok) {
    const detail = availability.blockers.map((b) => `- ${b.message}${b.hint ? `（建议：${b.hint}）` : ''}`).join('\n');
    throw conflictError(
      `工程当前不可用于批处理构建：\n${detail}`,
      '关闭 Vivado GUI / 等待其它构建结束后重试；确认没有 GUI 后再启动构建。',
      { blockers: availability.blockers },
    );
  }

  const parsed = parseXpr(ctx.xprPath, ctx);
  const runsInfo = currentRuns(parsed);
  const warnings = [];
  const effectiveImplRun = implRun || run || runsInfo.impl?.id || null;
  const effectiveSynthRun = synthRun || runsInfo.synth?.id || null;

  if (implRun && effectiveImplRun) {
    const target = parsed.runs.find((r) => r.id === effectiveImplRun);
    if (!target) throw envError(`工程中不存在 impl run：${effectiveImplRun}`, `可用 run：${parsed.runs.map((r) => r.id).join(', ')}`);
    if (target.kind !== 'impl') warnings.push(`指定的 run ${effectiveImplRun} 不是实现 run（Type=${target.rawType}）`);
    if (target.part && parsed.part && target.part !== parsed.part) {
      warnings.push(`run ${target.id} 的器件 ${target.part} 与工程器件 ${parsed.part} 不一致，可能不是预期 run`);
    }
  }
  if (synthRun) {
    const target = parsed.runs.find((r) => r.id === synthRun);
    if (!target) throw envError(`工程中不存在 synth run：${synthRun}`, `可用 run：${parsed.runs.map((r) => r.id).join(', ')}`);
  }
  if (top) {
    const exists = await designHasModule(ctx, parsed, top);
    if (!exists) {
      warnings.push(`top=${top} 未在设计源文件中找到 module 声明（可能拼写错误，或由 IP/TCL 动态产生）`);
    }
  }
  if (runsInfo.impl?.incrementalCheckpoint && !runsInfo.impl.incrementalCheckpoint.path) {
    warnings.push('impl run 的增量 checkpoint 路径为空');
  }

  // 可选额外约束（构建冒烟用：运行期 add_files 注入内存工程，不修改工程文件、不 save_project）
  let extraXdcAbs = null;
  if (extraXdc && String(extraXdc).trim()) {
    extraXdcAbs = path.resolve(ctx.projectDir, String(extraXdc).trim());
    if (!(await pathExists(extraXdcAbs))) {
      throw envError(
        `extra_xdc 约束文件不存在：${extraXdcAbs}`,
        '传 .xdc 文件的绝对路径（或相对工程根的路径），留空表示不注入。该参数仅用于构建冒烟，不会修改工程文件。',
      );
    }
    if (path.extname(extraXdcAbs).toLowerCase() !== '.xdc') {
      throw envError(`extra_xdc 必须是 .xdc 文件：${extraXdcAbs}`, '检查文件扩展名。');
    }
  }

  // 运行前备份 xpr（构建结束后由 job-runner 恢复，保证工程文件与备份一致）
  const backup = await backupXpr(ctx);

  const reportDirFor = (jobDir, jobId) => path.join(ctx.reportsDir, jobId);
  const baseEnv = {
    VIVADO_BIN: vivadoBin,
    VMCP_PROJECT_DIR: ctx.projectDir,
    VMCP_XPR: ctx.xprPath,
    VMCP_JOBS: String(normalizeJobs(jobs)),
    VMCP_STAGE: normalizedStage,
    VMCP_ALLOW_MISSING_INCR: '1',
    VMCP_XPR_BACKUP: backup.backupPath,
  };
  if (top) baseEnv.VMCP_TOP = String(top);
  if (effectiveSynthRun) baseEnv.VMCP_SYNTH_RUN = effectiveSynthRun;
  if (effectiveImplRun) baseEnv.VMCP_IMPL_RUN = effectiveImplRun;

  // 需要 jobId 才能确定的变量（VMCP_REPORT_DIR 必须与 job.reportDir 完全一致，否则 reports 聚合会找不到报告）
  const buildEnvFactory = (jobDir, jobId) => {
    const reportDir = reportDirFor(jobDir, jobId);
    const envObject = {
      ...baseEnv,
      VMCP_JOB_DIR: jobDir,
      VMCP_REPORT_DIR: reportDir,
    };
    if (extraXdcAbs) envObject.VMCP_EXTRA_XDC = extraXdcAbs;
    return envObject;
  };

  const timeout = Math.max(60, Number(timeoutSec) || DEFAULT_BUILD_TIMEOUTS[normalizedStage]);
  const scriptName = path.basename(tclPath);
  const banner = [
    `# Vivado MCP 构建 job`,
    `# stage=${normalizedStage} script=${scriptName}`,
    `# project=${ctx.projectDir}`,
    `# xpr=${ctx.xprPath}`,
    `# xpr 备份：${backup.backupPath}（构建结束后恢复）`,
    `# env: VMCP_JOBS=${baseEnv.VMCP_JOBS} VMCP_STAGE=${normalizedStage} VMCP_REPORT_DIR=<job>/reports` +
      (top ? ` VMCP_TOP=${top}` : '') +
      (effectiveSynthRun ? ` VMCP_SYNTH_RUN=${effectiveSynthRun}` : '') +
      (effectiveImplRun ? ` VMCP_IMPL_RUN=${effectiveImplRun}` : '') +
      (extraXdcAbs ? ` VMCP_EXTRA_XDC=${extraXdcAbs}` : ''),
    extraXdcAbs ? `# 额外约束（仅内存注入，不改工程）：${extraXdcAbs}` : '# 未注入额外约束（extra_xdc 为空）',
    `# 判定：退出码 0 + 完成标记 + 产物（bit 文件）齐全才算成功；DRC ERROR 会结构化解析。`,
  ].join('\n');

  const created = await createJob({
    ctx,
    kind: 'build',
    stage: normalizedStage,
    stepsFactory: (jobDir) => {
      const logPath = path.join(jobDir, 'vivado.log');
      return [{ name: `vivado-${normalizedStage}`, file: vivadoBin, args: buildVivadoArgs({ tclPath, logPath }), cwd: jobDir }];
    },
    env: buildEnvFactory,
    timeoutSec: timeout,
    reportDir: reportDirFor,
    restoreXpr: { xprPath: ctx.xprPath, backupPath: backup.backupPath },
    meta: {
      stage: normalizedStage,
      stageTcl: tclPath,
      scriptName,
      jobs: baseEnv.VMCP_JOBS,
      top: top || null,
      synthRun: effectiveSynthRun,
      implRun: effectiveImplRun,
      extraXdc: extraXdcAbs,
      runsWarnings: warnings,
      source: 'xpr-parse',
    },
    commandLabel: {
      file: vivadoBin,
      args: ['-mode', 'batch', '-notrace', '-nojournal', '-log', path.join('<job>', 'vivado.log'), '-source', tclPath],
    },
    banner,
  });

  return {
    job: created.job,
    jobDir: created.jobDir,
    ctx,
    backup,
    command: created.job.command,
    reportDir: path.join(ctx.reportsDir, created.job.id),
    tcl: tclPath,
    warnings,
    env: { ...baseEnv, ...(extraXdcAbs ? { VMCP_EXTRA_XDC: extraXdcAbs } : {}) },
    extraXdc: extraXdcAbs,
    runs: { synth: effectiveSynthRun, impl: effectiveImplRun },
  };
}

// ---------------------------------------------------------------------------
// 结果判定
// ---------------------------------------------------------------------------

async function findNewestBitstream(ctx, sinceMs) {
  const results = [];
  const scan = async (dir, depth) => {
    const entries = await listDirSafe(dir);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await scan(p, depth - 1);
        continue;
      }
      if (!/\.bit$/i.test(entry.name)) continue;
      const stat = await statOrNull(p);
      if (!stat) continue;
      if (sinceMs && stat.mtimeMs < sinceMs - 5000) continue;
      results.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  if (ctx.runsDir && (await pathExists(ctx.runsDir))) scan(ctx.runsDir, 2);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const best = results[0] || null;
  if (!best) return null;
  return {
    path: best.path,
    size: best.size,
    sizeHuman: humanBytes(best.size),
    mtime: new Date(best.mtimeMs).toISOString(),
    exists: true,
  };
}

/**
 * 构建结果判定：退出码 + 完成标记 + 产物三者齐全才算 ok。
 * 负路径（例如默认 XDC 下 write_bitstream 被 DRC 拒绝）会解析出结构化错误码与失败阶段。
 * @param {Awaited<ReturnType<typeof getJobStatus>>} status
 */
export async function evaluateBuildJob(status) {
  const text = await readTail(status.logFile, 2 * 1024 * 1024);
  const markers = parseMarkers(text);
  const errors = parseErrors(text);
  const warningsSummary = parseWarningsSummary(text);
  const structuredErrors = parseVivadoErrors(text);
  const drcErrors = pickDrcErrors(structuredErrors);
  const progress = parseProgress(text);
  const stage = status.stage;
  const ctx = createProjectContext(status.projectDir, status.xprPath || null);
  const sinceMs = status.startedAt ? Date.parse(status.startedAt) : null;

  const needBit = stage === 'bitstream' || stage === 'full';
  const markerCheck = markersSatisfied(markers, stage);
  let bitstream = null;
  if (markers.bitstreamOk?.path) {
    const bitPath = path.resolve(status.projectDir, markers.bitstreamOk.path);
    const stat = await statOrNull(bitPath);
    bitstream = { path: bitPath, exists: !!stat, size: stat ? stat.size : 0, sizeHuman: humanBytes(stat ? stat.size : 0), mtime: stat ? new Date(stat.mtimeMs).toISOString() : null };
  } else if (needBit) {
    bitstream = await findNewestBitstream(ctx, sinceMs);
  }

  // 防御性设计（Round 4 联调）：项目模式下 runs/<run>/runme.log 跨 reset 只追加不清空，
  // 当前 job 的 run.log 可能回放历史 flow 的 ERROR（例如上一次 DRC 失败遗留的 NSTD-1/UCIO-1）。
  // 当权威成功信号齐全（done/exit0/VMCP_FINISH ok/阶段标记/bit 存在）时，只把“当前 flow
  // （首个 VMCP_ 标记之后）”的日志 ERROR / 结构化错误作为失败证据，之前的归为 staleLogErrors 提示。
  const firstMarkerIndex = text.search(/^VMCP_[A-Z_]+/m);
  const strongSuccess =
    status.status === 'done' &&
    status.exitCode === 0 &&
    markerCheck.ok &&
    markers.lastFinish?.ok === true &&
    (!needBit || !!(bitstream && bitstream.exists && bitstream.size > 0));
  let activeErrors = errors.errors;
  let activeStructuredErrors = structuredErrors;
  let staleLogErrors = [];
  if (strongSuccess && firstMarkerIndex > 0) {
    const preText = text.slice(0, firstMarkerIndex);
    const markerText = text.slice(firstMarkerIndex);
    const preErrors = parseErrors(preText);
    const preStructured = parseVivadoErrors(preText);
    if (preErrors.errors.length > 0 || preStructured.length > 0) {
      staleLogErrors = preErrors.errors;
      activeErrors = parseErrors(markerText).errors;
      activeStructuredErrors = parseVivadoErrors(markerText);
    }
  }
  const activeDrcErrors = pickDrcErrors(activeStructuredErrors);

  const checks = [];
  const failures = [];
  const pushCheck = (name, passed, message) => {
    checks.push({ name, ok: passed, message: passed ? '' : message });
    if (!passed) failures.push({ code: name.toUpperCase(), message });
  };

  const structuredBrief = activeStructuredErrors
    .slice(0, 6)
    .map((e) => `[${e.code}] ${e.message.slice(0, 120)}`)
    .join('；');

  pushCheck('job_done', status.status === 'done', `job 状态为 ${status.status}（期望 done）${status.failures?.length ? '：' + status.failures.map((f) => f.message).join('；') : ''}`);
  pushCheck('exit_code_zero', status.exitCode === 0, `Vivado 退出码为 ${status.exitCode}（期望 0）`);
  if (markers.lastFinish) {
    pushCheck('finish_marker', markers.lastFinish.ok === true, `VMCP_FINISH 标记为失败：${markers.lastFinish.raw}`);
  }
  pushCheck('stage_markers', markerCheck.ok, `缺少完成标记：${markerCheck.missing.join(', ') || '未知'}`);
  pushCheck('no_vmcp_error', markers.errors.length === 0, `TCL 报告错误：${markers.errors.slice(0, 5).join('；')}`);
  pushCheck(
    'no_log_error',
    activeErrors.length === 0,
    `Vivado 日志有 ${activeErrors.length} 条 ERROR${structuredBrief ? `：${structuredBrief}` : ''}${staleLogErrors.length > 0 ? `（另有 ${staleLogErrors.length} 条历史回放 ERROR 已降级为提示）` : ''}`,
  );
  if (needBit) {
    pushCheck('bitstream_exists', !!(bitstream && bitstream.exists && bitstream.size > 0), bitstream ? `bit 文件不存在或大小为 0：${bitstream.path}` : '未找到生成的 .bit 文件，也未解析到 VMCP_BITSTREAM_OK');
  }

  // 结构化错误（如 DRC NSTD-1 / UCIO-1）单独进入 failures，带错误码与失败阶段，便于精确归因
  for (const item of activeStructuredErrors.slice(0, 20)) {
    failures.push({
      code: `${String(item.scope).trim()}_${item.id}`.replace(/\s+/g, '_'),
      scope: item.scope,
      errorId: item.id,
      stage: item.stage,
      message: `[${item.code}] ${item.message}`,
      resolve: item.resolve || '',
    });
  }
  for (const message of markers.errors.slice(0, 10)) {
    failures.push({ code: 'VMCP_ERROR', message });
  }

  const failedStage = deriveFailedStage({ stage, structuredErrors: activeStructuredErrors, progress, markers, needBit, ok: failures.length === 0 });

  const ok = failures.length === 0;
  const logStat = await statOrNull(status.logFile);
  const notes = [];
  for (const item of errors.criticalWarnings.slice(0, 20)) {
    const hint = explainError(item.message);
    notes.push({ level: 'critical-warning', message: item.message, hint });
  }
  if (warningsSummary) notes.push({ level: 'summary', message: warningsSummary.raw });
  if (staleLogErrors.length > 0) {
    notes.push({
      level: 'stale-log',
      message: `检测到 ${staleLogErrors.length} 条历史回放的 ERROR（发生在当前 flow 的 VMCP 标记之前，已降级为提示、不影响 ok 判定）：${staleLogErrors.slice(0, 3).map((e) => e.message.slice(0, 120)).join('；')}`,
    });
  }

  return {
    ...status,
    ok,
    kind: 'build',
    checks,
    markers,
    structuredErrors: activeStructuredErrors,
    drcErrors: activeDrcErrors,
    failedStage,
    bitstream: needBit ? bitstream : null,
    reports: status.artifacts?.reports || [],
    reportDir: status.artifacts?.reportDir || null,
    errors: activeErrors,
    staleLogErrors,
    staleLogErrorCount: staleLogErrors.length,
    criticalWarnings: errors.criticalWarnings,
    warningsSummary,
    notes,
    failures,
    extraXdc: status.meta?.extraXdc || null,
    evidence: {
      logFile: status.logFile,
      vivadoLog: status.artifacts?.vivadoLog || null,
      logSize: logStat ? logStat.size : 0,
      logSizeHuman: humanBytes(logStat ? logStat.size : 0),
      reportDir: status.artifacts?.reportDir || null,
      bitstream: bitstream || null,
      jobDir: status.jobDir,
      extraXdc: status.meta?.extraXdc || null,
      xprBackup: status.restoreXpr?.backupPath || null,
      xprRestored: status.xprRestored || null,
    },
    summary: ok
      ? `${stageLabel(stage)}成功：退出码 0，完成标记齐全${needBit ? `，bit 文件 ${bitstream.sizeHuman}` : ''}（耗时 ${humanDuration(status.elapsedMs)}）`
      : `${stageLabel(stage)}未通过${failedStage ? `（失败阶段：${failedStage}）` : ''}：${failures.map((f) => f.message).slice(0, 4).join('；')}`,
  };
}

/** 推断失败发生在哪个阶段（优先结构化错误自带的阶段，其次完成标记/进度） */
function deriveFailedStage({ stage, structuredErrors, progress, markers, needBit, ok }) {
  if (ok) return null;
  const errorStage = [...structuredErrors].reverse().find((e) => e.stage)?.stage;
  if (errorStage) return errorStage;
  if (markers.synthDone && !markers.implDone) return stage === 'full' ? 'impl' : 'synth';
  if (markers.implDone && needBit && !markers.bitstreamOk) return 'write_bitstream';
  if (markers.synthDone && stage === 'full') return 'impl';
  if (progress?.stage) return progress.stage;
  return stage === 'synth' ? 'synth_design' : 'unknown';
}

function stageLabel(stage) {
  return { synth: '综合', impl: '实现', bitstream: '比特流', full: '综合+实现+比特流' }[stage] || stage;
}

function humanDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  return `${m}m${total % 60}s`;
}

/** 启动 + 等待 + 判定（CLI / 测试复用） */
export async function runBuildJob({
  projectDir,
  stage = 'full',
  top = null,
  run = null,
  synthRun = null,
  implRun = null,
  jobs = DEFAULT_JOBS,
  extraXdc = null,
  waitTimeoutSec = 1800,
  env = process.env,
  cwd = process.cwd(),
  allowExternalVivado = false,
} = {}) {
  const started = await startBuildJob({ projectDir, stage, top, run, synthRun, implRun, jobs, extraXdc, env, cwd, allowExternalVivado });
  const waited = await waitJob({
    projectDir: started.ctx.projectDir,
    jobId: started.job.id,
    timeoutMs: Math.max(5, waitTimeoutSec) * 1000,
    env,
    cwd,
  });
  const evaluated = await evaluateBuildJob(waited);
  return { ...started, waited, evaluated };
}
