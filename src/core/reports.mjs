// 报告汇总（vivado_reports / CLI reports）：解析 job 或工程里最新的时序/资源/功耗报告 + bit 文件信息。
import path from 'node:path';
import { createProjectContext, resolveProject } from './config.mjs';
import { evaluateBuildJob } from './build.mjs';
import { evaluateHwJob } from './hw.mjs';
import { getJobStatus, listJobs } from './jobs.mjs';
import { evaluateSimJob } from './sim.mjs';
import { parseBusSkew, parsePower, parseTiming, parseUtilization } from './parse.mjs';
import {
  humanBytes,
  listDirSafe,
  pathExists,
  readTextFileOrNull,
  statOrNull,
} from './util.mjs';

const MAX_REPORT_BYTES = 4 * 1024 * 1024;

function classifyReport(name) {
  const n = name.toLowerCase();
  if (/bus_skew|bus-skew/.test(n)) return 'bus_skew';
  if (/timing/.test(n)) return 'timing';
  if (/util/.test(n)) return 'utilization';
  if (/power/.test(n)) return 'power';
  if (/drc|methodology/.test(n)) return 'drc';
  return 'other';
}

/** 同一类报告里优先使用实现后（impl/route）的报告，其次 synth */
function reportPriority(name) {
  const n = String(name).toLowerCase();
  let p = 0;
  if (/impl|routed|route|placed/.test(n)) p -= 2;
  if (/synth/.test(n)) p += 1;
  return p;
}

async function listReportFiles(dir) {
  if (!dir) return [];
  const entries = await listDirSafe(dir);
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = path.join(dir, entry.name);
    const stat = await statOrNull(p);
    out.push({
      name: entry.name,
      path: p,
      size: stat ? stat.size : 0,
      sizeHuman: humanBytes(stat ? stat.size : 0),
      kind: classifyReport(entry.name),
      // Round 4：报告 mtime / 是否早于本次构建（stale 在 collectReports 里按 job 开始时间计算）
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : null,
      mtimeMs: stat ? stat.mtimeMs : null,
      state: 'present',
      stale: null,
    });
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind) || reportPriority(a.name) - reportPriority(b.name) || a.name.localeCompare(b.name));
  return out;
}

/**
 * Round 4：时序判定汇总（reports.verdict）。
 * timingMet 覆盖已分析的 setup/pulseWidth/hold；bus skew 单独给 busSkewAnalyzed/busSkewMet。
 */
function buildTimingVerdict(timing, busSkew) {
  const checks = timing?.checks || null;
  const setupMet = checks?.setup?.met ?? null;
  const holdAnalyzed = checks?.hold?.analyzed === true;
  const holdMet = holdAnalyzed ? (checks?.hold?.met ?? null) : null;
  const pulseWidthMet = checks?.pulseWidth?.met ?? null;
  const timingMet =
    setupMet === null && pulseWidthMet === null && !holdAnalyzed
      ? null
      : setupMet === true && pulseWidthMet === true && (!holdAnalyzed || holdMet === true);
  const notes = [];
  if (timing?.hasReport) {
    if (timing.reportKind === 'max') notes.push('报告为 -delay_type max：hold（WHS/THS）未分析，timingMet 仅覆盖 setup+pulseWidth');
    else if (timing.reportKind === 'min_max') notes.push('报告为 -delay_type min_max：timingMet 覆盖 setup+hold+pulseWidth');
    if (holdAnalyzed && holdMet === false) notes.push('hold 判定不满足（WHS<0 或 THS 有违例端点）');
    if (setupMet === false) notes.push('setup 判定不满足（WNS<0 或 TNS 有违例端点）');
    if (pulseWidthMet === false) notes.push('pulse width 判定不满足（WPWS<0 或 TPWS 有违例端点）');
  }
  if (busSkew) {
    if (busSkew.applicable) notes.push(`bus skew：${busSkew.constraints} 条约束，最差 slack=${busSkew.worstSlackNs}ns（${busSkew.met ? 'MET' : 'VIOLATED'}）`);
    else notes.push('bus skew：报告存在但无约束（applicable=false）');
  } else {
    notes.push('未找到 bus skew 报告（可能没有 set_bus_skew 约束，或本阶段未生成该报告）');
  }
  return {
    timingMet,
    timingScope: timing?.timingScope ?? null,
    setupMet,
    holdAnalyzed,
    holdMet,
    pulseWidthMet,
    busSkewAnalyzed: busSkew ? busSkew.applicable === true : false,
    busSkewMet: busSkew && busSkew.applicable ? busSkew.met : null,
    notes,
  };
}

/** 找工程里最新的报告目录：优先“报告最完整”的（含 timing > 任意报告），同级再按本工具链 job 目录/mtime */
async function findLatestReportDir(ctx) {
  const entries = await listDirSafe(ctx.reportsDir);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ctx.reportsDir, entry.name);
    const stat = await statOrNull(dir);
    const files = (await listDirSafe(dir)).filter((f) => f.isFile());
    const hasTiming = files.some((f) => /timing/i.test(f.name) && /\.rpt$/i.test(f.name));
    const hasAny = files.length > 0;
    // 本工具链 job 报告目录名形如 <YYYYMMDDTHHMMSSZ>-<stage>-<hex>
    const isJobDir = /^\d{8}T\d{6}Z-/.test(entry.name);
    candidates.push({ name: entry.name, dir, isJobDir, hasTiming, hasAny, mtimeMs: stat ? stat.mtimeMs : 0 });
  }
  candidates.sort(
    (a, b) =>
      Number(b.hasTiming) - Number(a.hasTiming) ||
      Number(b.hasAny) - Number(a.hasAny) ||
      Number(b.isJobDir) - Number(a.isJobDir) ||
      b.mtimeMs - a.mtimeMs ||
      b.name.localeCompare(a.name),
  );
  return candidates.length > 0 ? candidates[0].dir : null;
}

/** 兜底：工程 runs 目录里的旧报告（例如已有 synth_2 的利用率报告） */
async function findRunsReports(ctx) {
  const entries = await listDirSafe(ctx.runsDir);
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(ctx.runsDir, entry.name);
    for (const f of await listDirSafe(runDir)) {
      if (!f.isFile()) continue;
      if (!/\.(rpt|txt)$/i.test(f.name)) continue;
      const p = path.join(runDir, f.name);
      const stat = await statOrNull(p);
      if (!stat) continue;
      files.push({ name: `${entry.name}/${f.name}`, path: p, size: stat.size, sizeHuman: humanBytes(stat.size), kind: classifyReport(f.name), mtimeMs: stat.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

async function findNewestBitstream(ctx) {
  const entries = await listDirSafe(ctx.runsDir);
  const results = [];
  const scan = async (dir, depth) => {
    for (const entry of await listDirSafe(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await scan(p, depth - 1);
        continue;
      }
      if (!/\.bit$/i.test(entry.name)) continue;
      const stat = await statOrNull(p);
      if (stat) results.push({ path: p, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  if (ctx.runsDir && (await pathExists(ctx.runsDir))) await scan(ctx.runsDir, 2);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (results.length === 0) return null;
  const best = results[0];
  return { path: best.path, exists: true, size: best.size, sizeHuman: humanBytes(best.size), mtime: new Date(best.mtimeMs).toISOString() };
}

/**
 * 汇总报告。
 * @param {object} options
 * @param {string} [options.projectDir]
 * @param {string} [options.jobId] 指定 job；不传则用工程最新报告
 */
export async function collectReports({ projectDir, jobId = null, env = process.env, cwd = process.cwd() } = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd });
  const ctx = createProjectContext(resolved.projectDir, resolved.xprPath);
  let jobSummary = null;
  let reportDir = null;
  let source = null;
  let evaluated = null;

  if (jobId) {
    const status = await getJobStatus({ projectDir: ctx.projectDir, jobId, env, cwd });
    const active = status.status === 'running' || status.status === 'starting';
    // hw/debug job 走硬件结果判定；构建报告对它们不适用（下方 missing/notes 会说明）
    evaluated = active
      ? status
      : status.kind === 'sim'
        ? await evaluateSimJob(status)
        : status.kind === 'hw' || status.kind === 'debug'
          ? await evaluateHwJob(status)
          : await evaluateBuildJob(status);
    jobSummary = {
      id: status.id,
      kind: status.kind,
      stage: status.stage,
      status: status.status,
      ok: active ? null : evaluated.ok ?? null,
      summary: active ? 'job 仍在运行，报告可能不完整（已生成的报告会正常解析）' : evaluated.summary || null,
      startedAt: status.startedAt,
      startedAtMs: status.startedAt ? Date.parse(status.startedAt) || null : null,
      endedAt: status.endedAt,
      elapsedMs: status.elapsedMs,
      failures: active ? [] : evaluated.failures || [],
      logFile: status.logFile,
      jobDir: status.jobDir,
      bitstream: active ? null : evaluated.bitstream || evaluated.artifacts?.bitstream || null,
    };
    reportDir = status.artifacts?.reportDir || evaluated.evidence?.reportDir || null;
    source = 'job';
  } else {
    reportDir = await findLatestReportDir(ctx);
    if (!reportDir) {
      // 没有本工具链的报告目录时，回退到工程 runs 里最近一次的 rpt
      const runsReports = await findRunsReports(ctx);
      if (runsReports.length > 0) {
        source = 'project-runs-fallback';
        const timingFile = runsReports.find((f) => f.kind === 'timing');
        const utilFile = runsReports.find((f) => f.kind === 'utilization');
        const powerFile = runsReports.find((f) => f.kind === 'power');
        const pick = async (file) => (file ? await readTextFileOrNull(file.path).catch(() => null) : null);
        const [timingText, utilText, powerText] = await Promise.all([pick(timingFile), pick(utilFile), pick(powerFile)]);
        const timing = { ...parseTiming(timingText || ''), reportFile: timingFile ? timingFile.path : null, busSkew: null };
        const busSkew = null;
        return {
          ok: true,
          source,
          projectDir: ctx.projectDir,
          jobId: null,
          reportDir: null,
          files: runsReports.map(({ mtimeMs, ...rest }) => rest),
          job: null,
          timing,
          utilization: parseUtilization(utilText || ''),
          power: parsePower(powerText || ''),
          bitstream: await findNewestBitstream(ctx),
          verdict: buildTimingVerdict(timing, busSkew),
          missing: [
            !timingFile ? '时序报告（需要 impl/bitstream 构建的 report_timing_summary）' : null,
            !utilFile ? '资源报告' : null,
            !powerFile ? '功耗报告（需要 impl 构建）' : null,
          ].filter(Boolean),
          notes: ['未找到本工具链产生的报告目录（.vivado-mcp/reports），以下数据来自工程 runs 目录里的历史报告。'],
        };
      }
      throw new (await import('./errors.mjs')).McpError('没有找到任何报告', {
        code: 'NO_REPORTS',
        kind: 'business',
        hint: '先跑一次构建（vivado_build_start stage=impl/bitstream/full），或传已有报告对应的 job_id。',
      });
    }
    source = 'latest-report-dir';
  }

  const files = await listReportFiles(reportDir);
  const pick = (kind) => files.find((f) => f.kind === kind) || null;
  const read = async (file) => (file ? await readTextFileOrNull(file.path).catch(() => null) : null);
  let [timingText, utilText, powerText] = await Promise.all([read(pick('timing')), read(pick('utilization')), read(pick('power'))]);
  let busSkewText = await read(pick('bus_skew'));

  // 兜底：如果 job.reportDir 里没有报告，但日志里出现过 VMCP_REPORT <path>，用这些路径的公共目录再找一次
  if (jobId && !timingText && !utilText && !powerText) {
    const markerReports = evaluated?.markers?.reports || evaluated?.artifacts?.reports?.map((r) => r.path) || [];
    const dirs = [...new Set(markerReports.map((p) => path.dirname(path.resolve(ctx.projectDir, p))))];
    for (const dir of dirs) {
      const fallbackFiles = await listReportFiles(dir);
      if (fallbackFiles.length === 0) continue;
      reportDir = dir;
      files.push(...fallbackFiles.filter((f) => !files.some((x) => x.path === f.path)));
      const p = (kind) => fallbackFiles.find((f) => f.kind === kind) || null;
      [timingText, utilText, powerText] = await Promise.all([
        read(p('timing')),
        read(p('utilization')),
        read(p('power')),
      ]);
      busSkewText = busSkewText || (await read(p('bus_skew')));
      if (timingText || utilText || powerText) break;
    }
  }

  // Round 4：每条报告标记 stale（早于本次构建开始时间 → 可能是旧报告）
  const buildStartedAtMs = jobSummary?.startedAtMs ?? null;
  if (buildStartedAtMs) {
    for (const file of files) {
      file.stale = file.mtimeMs ? file.mtimeMs < buildStartedAtMs : null;
    }
  }

  const timingFile = pick('timing');
  const busSkewFile = pick('bus_skew');
  const busSkew = busSkewFile ? { ...parseBusSkew(busSkewText || ''), reportFile: busSkewFile.path } : null;
  const timing = {
    ...parseTiming(timingText || ''),
    reportFile: timingFile ? timingFile.path : null,
    busSkew,
  };
  const utilization = parseUtilization(utilText || '');
  const power = parsePower(powerText || '');
  const bitstream = evaluated?.bitstream || evaluated?.artifacts?.bitstream || (await findNewestBitstream(ctx));

  const isHwJob = jobSummary && (jobSummary.kind === 'hw' || jobSummary.kind === 'debug');
  const missing = isHwJob
    ? []
    : [
        !timing?.hasReport ? '时序报告（report_timing_summary）' : null,
        !utilization?.hasReport ? '资源报告（report_utilization）' : null,
        !power?.hasReport ? '功耗报告（report_power，通常只有实现后才生成）' : null,
        (evaluated?.kind === 'build' || !jobId) && !bitstream ? 'bit 文件（需要 stage=bitstream/full）' : null,
      ].filter(Boolean);

  const verdict = buildTimingVerdict(timing, busSkew);
  const notes = [];
  if (isHwJob) notes.push(`该 job 是硬件调试任务（kind=${jobSummary.kind}，stage=${jobSummary.stage}），不产生时序/资源/功耗报告；结果见 job.summary/failures 与 job 目录下 hw_result.json。`);
  if (missing.length > 0) notes.push(`缺少：${missing.join('、')}；可先运行对应阶段的构建。`);
  if (!isHwJob) {
    for (const note of verdict.notes) notes.push(note);
    const staleFiles = files.filter((f) => f.stale === true).map((f) => f.name);
    if (staleFiles.length > 0) notes.push(`以下报告早于本次构建开始时间（可能为旧报告）：${staleFiles.join(', ')}`);
  }

  return {
    ok: true,
    source,
    projectDir: ctx.projectDir,
    jobId: jobId || null,
    reportDir,
    files,
    job: jobSummary,
    timing,
    utilization,
    power,
    bitstream,
    verdict,
    missing,
    notes,
  };
}
