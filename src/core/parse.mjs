// 日志/报告文本解析：T1 的 VMCP 标记、进度、错误、时序/资源/功耗报告、仿真 PASS 统计。
// 纯函数（不碰文件系统），便于 fixture 单测。

function splitLines(text) {
  return String(text ?? '').split(/\r?\n/);
}

function toNumber(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '' || s === '-' || s === '--' || s === 'NA' || s === 'N/A' || /^inf(inity)?$/i.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function unquote(s) {
  const v = String(s ?? '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// ---------------------------------------------------------------------------
// T1 机器可读标记（SPEC §3.2）
// ---------------------------------------------------------------------------

const MARKER_RE = /^\s*VMCP_(SYNTH_DONE|IMPL_DONE|BITSTREAM_OK|REPORT|ERROR|FINISH)\b(.*)$/;

/** 解析 key=value 片段（"progress=100% status=Complete!"） */
export function parseKvPairs(text) {
  const out = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s]+)/g;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * 解析 VMCP_* 标记行。
 * @returns {{synthDone:object|null, implDone:object|null, bitstreamOk:object|null,
 *            reports:string[], errors:string[], finishes:Array<{ok:boolean,raw:string}>,
 *            lastFinish:{ok:boolean,raw:string}|null}}
 */
export function parseMarkers(text) {
  const markers = {
    synthDone: null,
    implDone: null,
    bitstreamOk: null,
    reports: [],
    errors: [],
    finishes: [],
    lastFinish: null,
  };
  for (const line of splitLines(text)) {
    const m = MARKER_RE.exec(line);
    if (!m) continue;
    const kind = m[1];
    const rest = (m[2] || '').trim();
    if (kind === 'SYNTH_DONE' || kind === 'IMPL_DONE') {
      const kv = parseKvPairs(rest);
      const progress = kv.progress != null ? toNumber(String(kv.progress).replace('%', '')) : null;
      const entry = {
        raw: line.trim(),
        progress,
        status: kv.status != null ? kv.status : rest || null,
        extra: kv,
        at: null,
      };
      if (kind === 'SYNTH_DONE') markers.synthDone = entry;
      else markers.implDone = entry;
    } else if (kind === 'BITSTREAM_OK') {
      markers.bitstreamOk = { raw: line.trim(), path: unquote(rest) || null, extra: parseKvPairs(rest) };
    } else if (kind === 'REPORT') {
      const p = unquote(rest);
      if (p) markers.reports.push(p);
    } else if (kind === 'ERROR') {
      if (rest) markers.errors.push(rest);
    } else if (kind === 'FINISH') {
      const ok = /^ok\b/i.test(rest) || /ok/i.test(rest);
      const entry = { ok, raw: line.trim(), at: null };
      markers.finishes.push(entry);
      markers.lastFinish = entry;
    }
  }
  return markers;
}

/** 标记是否表明构建成功（stages 由调用方按 stage 决定必需项） */
export function markersSatisfied(markers, stage) {
  const needSynth = stage === 'synth' || stage === 'full';
  const needImpl = stage === 'impl' || stage === 'bitstream' || stage === 'full';
  const needBit = stage === 'bitstream' || stage === 'full';
  if (needSynth && !markers.synthDone) return { ok: false, missing: ['VMCP_SYNTH_DONE'] };
  if (needImpl && !markers.implDone) return { ok: false, missing: ['VMCP_IMPL_DONE'] };
  if (needBit && !markers.bitstreamOk) return { ok: false, missing: ['VMCP_BITSTREAM_OK'] };
  return { ok: true, missing: [] };
}

// ---------------------------------------------------------------------------
// 进度与阶段
// ---------------------------------------------------------------------------

const STAGE_HINTS = [
  [/synth_design completed|Synthesis finished/i, 'synth_done'],
  [/route_design completed/i, 'route_done'],
  [/write_bitstream completed|\bWriting bitstream\b/i, 'write_bitstream'],
  [/launch_runs synth|Starting synth|Running synth_design/i, 'synth'],
  [/opt_design\b/i, 'opt_design'],
  [/place_design\b/i, 'place_design'],
  [/route_design\b/i, 'route_design'],
  [/launch_runs impl|Starting impl|Running impl/i, 'impl'],
];

/** 从日志文本推断进度百分比与当前阶段 */
export function parseProgress(text) {
  const lines = splitLines(text);
  let percent = null;
  let source = null;
  let stage = null;
  for (const line of lines) {
    let m = null;
    if (/VMCP_/.test(line) && /progress\s*=/.test(line)) {
      m = /progress\s*=\s*(\d{1,3})\s*%?/i.exec(line);
      if (m) {
        percent = Math.min(100, Number(m[1]));
        source = 'marker';
      }
    } else {
      m = /(?:^|\s)(?:PROGRESS|Progress)\s*[:=]\s*(\d{1,3})\s*%/.exec(line);
      if (m) {
        percent = Math.min(100, Number(m[1]));
        source = 'progress-line';
      } else {
        m = /^\s*\[\s*(\d{1,3})\s*%\]/.exec(line);
        if (m) {
          percent = Math.min(100, Number(m[1]));
          source = 'bracket';
        }
      }
    }
    for (const [re, hint] of STAGE_HINTS) {
      if (re.test(line)) stage = hint;
    }
  }
  return { percent, source, stage };
}

// ---------------------------------------------------------------------------
// 错误 / 警告
// ---------------------------------------------------------------------------

const ERROR_RE = /^\s*(?:ERROR|FATAL)\s*:\s*(.*)$/;
const CRITICAL_WARNING_RE = /^\s*CRITICAL\s+WARNING\s*:\s*(.*)$/;
const MAX_COLLECTED = 40;

/** 解析日志中的 ERROR / CRITICAL WARNING 行（区分级别，不做“warning 当 error”） */
export function parseErrors(text) {
  const errors = [];
  const criticalWarnings = [];
  const seen = new Set();
  for (const line of splitLines(text)) {
    const err = ERROR_RE.exec(line);
    if (err) {
      const message = err[1].trim();
      const key = `E:${message.slice(0, 200)}`;
      if (message && !seen.has(key) && errors.length < MAX_COLLECTED) {
        seen.add(key);
        errors.push({ severity: 'ERROR', message: message.slice(0, 500), raw: line.trim().slice(0, 800) });
      }
      continue;
    }
    const cw = CRITICAL_WARNING_RE.exec(line);
    if (cw) {
      const message = cw[1].trim();
      const key = `W:${message.slice(0, 200)}`;
      if (message && !seen.has(key) && criticalWarnings.length < MAX_COLLECTED) {
        seen.add(key);
        criticalWarnings.push({ severity: 'CRITICAL WARNING', message: message.slice(0, 500), raw: line.trim().slice(0, 800) });
      }
    }
  }
  return { errors, criticalWarnings, errorCount: errors.length, criticalWarningCount: criticalWarnings.length, truncated: errors.length >= MAX_COLLECTED || criticalWarnings.length >= MAX_COLLECTED };
}

/** 解析 Vivado 的 "... Infos, ... Warnings, ... Critical Warnings and ... Errors encountered." 汇总行 */
export function parseWarningsSummary(text) {
  const re = /(\d+)\s+Infos?,\s*(\d+)\s+Warnings?,\s*(\d+)\s+Critical\s+Warnings?\s+and\s+(\d+)\s+Errors?/i;
  let last = null;
  for (const line of splitLines(text)) {
    const m = re.exec(line);
    if (m) {
      last = {
        infos: Number(m[1]),
        warnings: Number(m[2]),
        criticalWarnings: Number(m[3]),
        errors: Number(m[4]),
        raw: line.trim(),
      };
    }
  }
  return last;
}

const STAGE_TRACKERS = [
  [/write_bitstream/i, 'write_bitstream'],
  [/route_design\b/i, 'route_design'],
  [/phys_opt_design\b/i, 'phys_opt_design'],
  [/place_design\b/i, 'place_design'],
  [/opt_design\b/i, 'opt_design'],
  [/init_design\b/i, 'init_design'],
  [/synth_design\b/i, 'synth_design'],
];

/**
 * 结构化解析 Vivado 错误行：`ERROR: [DRC NSTD-1] Unspecified I/O Standard: ...`
 * 返回 [{severity, scope, code, id, message, stage, resolve, raw}]
 *  - code 形如 'DRC NSTD-1'，便于在 failures[] 里稳定引用；
 *  - stage 根据错误出现前最近的流程关键字推断（如 write_bitstream）。
 */
export function parseVivadoErrors(text) {
  const out = [];
  const seen = new Set();
  let stage = null;
  // Vivado 错误行形如：ERROR: [DRC NSTD-1] msg / ERROR: [Common 17-69] msg / ERROR: [USF-XSim-62] msg
  const re = /^\s*(ERROR|FATAL)\s*:\s*\[([^\]]+)\]\s*(.*)$/;
  let pendingResolve = false;
  for (const line of splitLines(text)) {
    for (const [pattern, name] of STAGE_TRACKERS) {
      if (pattern.test(line)) {
        stage = name;
        break;
      }
    }
    const m = re.exec(line);
    if (m) {
      const severity = m[1];
      const bracket = m[2].trim();
      const message = m[3].trim();
      let scope = bracket;
      let id = '';
      const withSpace = /^(.+?)\s+([A-Za-z0-9_]+-\d+)$/.exec(bracket);
      if (withSpace) {
        scope = withSpace[1].trim();
        id = withSpace[2];
      } else {
        const trailing = /^(.*)-(\d+)$/.exec(bracket);
        if (trailing) {
          scope = trailing[1];
          id = trailing[2];
        }
      }
      const code = id ? `${scope} ${id}` : scope;
      const key = `${code}|${message.slice(0, 160)}`;
      if (!seen.has(key) && out.length < 60) {
        seen.add(key);
        out.push({
          severity,
          scope,
          id,
          code,
          message: message.slice(0, 600),
          stage,
          resolve: null,
          raw: line.trim().slice(0, 900),
        });
      }
      pendingResolve = true;
      continue;
    }
    if (pendingResolve && /^\s*(Resolution|解决办法|建议)\s*[:：]/i.test(line)) {
      if (out.length > 0) out[out.length - 1].resolve = line.replace(/^\s*(Resolution|解决办法|建议)\s*[:：]\s*/i, '').trim().slice(0, 400);
      pendingResolve = false;
    } else if (line.trim() !== '') {
      pendingResolve = false;
    }
  }
  return out;
}

/** 从结构化错误里挑选 DRC 错误（DRC 拒绝 write_bitstream 是常见负路径） */
export function pickDrcErrors(structuredErrors) {
  return (structuredErrors || []).filter((e) => /^DRC$/i.test(e.scope) || /^DRC\s/i.test(e.code));
}

/** 常见失败原因的中文归因提示 */
export function explainError(message) {
  const s = String(message || '');
  if (/\[Constraints\s+18-\d+\]/i.test(s)) return '约束（XDC）与当前设计不匹配，检查端口/时钟/调试核名是否存在于顶层';
  if (/\[Vivado\s+12-|\[Common\s+17-/i.test(s) && /launch_runs|run/i.test(s)) return 'run 启动失败，可能是增量 checkpoint 缺失、run 被锁或工程状态不一致';
  if (/incremental_checkpoint|Incremental/i.test(s)) return '增量 checkpoint 引用无效，可清空 incremental_checkpoint 后重跑';
  if (/locked|lock/i.test(s)) return '工程被 Vivado GUI 或其它进程锁定，先关闭 GUI/等待批处理结束';
  if (/synthesis failed|Implementation failed|fail/i.test(s)) return '综合/实现步骤失败，先看 log 里第一条 ERROR 的上下文';
  if (/\[Simulator|simulation/i.test(s)) return '仿真过程报错，检查 testbench 与 DUT 端口/参数是否匹配';
  return '';
}

// ---------------------------------------------------------------------------
// 时序报告（report_timing_summary）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 时序报告（report_timing_summary）—— Round 4 P0 重写
// 设计要点：
//   1. 按 section 锚点取表（Design/Intra/Inter/Other Path Groups），绝不把
//      Other Path Groups 当成 Design Summary；
//   2. 列定位用表头列起始 index 切片（不用 whitespace split），空列保留 null；
//   3. Inter 表兼容 2018.3 的 From/To Clock 与新版本 Source/Destination Clock；
//   4. 同时支持 -delay_type max（无 WHS/THS）与 min_max（含 WHS/THS）两种报告。
// ---------------------------------------------------------------------------

const TIMING_NUMERIC_COLUMNS = [
  { key: 'wns', label: 'WNS(ns)' },
  { key: 'tns', label: 'TNS(ns)' },
  { key: 'tnsFailingEndpoints', label: 'TNS Failing Endpoints' },
  { key: 'tnsTotalEndpoints', label: 'TNS Total Endpoints' },
  { key: 'whs', label: 'WHS(ns)' },
  { key: 'ths', label: 'THS(ns)' },
  { key: 'thsFailingEndpoints', label: 'THS Failing Endpoints' },
  { key: 'thsTotalEndpoints', label: 'THS Total Endpoints' },
  { key: 'wpws', label: 'WPWS(ns)' },
  { key: 'tpws', label: 'TPWS(ns)' },
  { key: 'tpwsFailingEndpoints', label: 'TPWS Failing Endpoints' },
  { key: 'tpwsTotalEndpoints', label: 'TPWS Total Endpoints' },
];

const TIMING_NAME_COLUMNS = [
  { key: 'pathGroup', labels: ['Path Group'] },
  { key: 'fromClock', labels: ['From Clock', 'Source Clock'] },
  { key: 'toClock', labels: ['To Clock', 'Destination Clock'] },
  { key: 'clock', labels: ['Clock'] },
];

const TIMING_SECTION_TITLES = ['Design Timing Summary', 'Intra Clock Table', 'Inter Clock Table', 'Other Path Groups Table', 'Clock Summary', 'Timing Details'];

function isTimingSectionTitle(line) {
  const text = String(line || '').replace(/^\s*\|?\s*/, '').replace(/\s*$/, '');
  return TIMING_SECTION_TITLES.includes(text);
}

/** 在 section 锚点后找表头行（含 required 里所有列名），返回 header 下标或 -1 */
function findTimingTableHeader(lines, title, required) {
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || '');
    const trimmed = line.replace(/^\s*\|?\s*/, '').replace(/\s*$/, '');
    if (trimmed !== title) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 24); j++) {
      const candidate = lines[j];
      if (!candidate || !candidate.trim()) continue;
      if (isTimingSectionTitle(candidate)) break;
      if (required.every((token) => candidate.includes(token))) return j;
    }
  }
  return -1;
}

/** 从表头行解析列起始 index（数值列 + name 列），按位置排序后每个列切片到下一列起点 */
function parseTimingHeaderColumns(headerLine) {
  const columns = [];
  for (const { key, label } of TIMING_NUMERIC_COLUMNS) {
    let idx = headerLine.indexOf(label);
    while (idx >= 0) {
      const before = idx > 0 ? headerLine[idx - 1] : ' ';
      const after = idx + label.length < headerLine.length ? headerLine[idx + label.length] : ' ';
      if (!/[A-Za-z0-9_()]/.test(before) && !/[A-Za-z0-9_()]/.test(after)) break;
      idx = headerLine.indexOf(label, idx + 1);
    }
    if (idx >= 0) columns.push({ key, type: 'number', label, start: idx });
  }
  const nameLabels = [];
  for (const column of TIMING_NAME_COLUMNS) for (const label of column.labels) nameLabels.push({ key: column.key, label });
  nameLabels.sort((a, b) => b.label.length - a.label.length);
  const nameRegex = new RegExp(`(?:^|\\s)(${nameLabels.map((n) => n.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=\\s|$)`, 'g');
  let match = null;
  while ((match = nameRegex.exec(headerLine)) !== null) {
    const label = match[1];
    const start = match.index + (match[0].length - label.length);
    const def = nameLabels.find((n) => n.label === label);
    if (!def) continue;
    if (columns.some((c) => c.start === start)) continue;
    columns.push({ key: def.key, type: 'name', label, start });
  }
  columns.sort((a, b) => a.start - b.start || a.label.localeCompare(b.label));
  return columns;
}

/** 按列起始 index 切片一行；空串/NA → null，数字列 toNumber */
function parseTimingRowByColumns(rowLine, columns) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    const end = i + 1 < columns.length ? columns[i + 1].start : Math.max(rowLine.length, column.start);
    const raw = rowLine.slice(column.start, end).trim();
    if (column.type === 'number') {
      obj[column.key] = raw === '' || /^NA$/i.test(raw) ? null : toNumber(raw);
    } else {
      obj[column.key] = raw === '' ? null : raw;
    }
  }
  return obj;
}

function isSeparatorLine(line) {
  return /^[\s\-+|]*$/.test(line) && /-/.test(line);
}

/** 收集表头后的数据行（跳过分隔线；遇空行/下一 section 结束） */
function collectTimingRows(lines, headerIndex) {
  let i = headerIndex + 1;
  while (i < lines.length && isSeparatorLine(lines[i])) i++;
  const rows = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) break;
    if (isSeparatorLine(line)) continue;
    if (isTimingSectionTitle(line)) break;
    rows.push(line);
    if (rows.length > 128) break;
  }
  return rows;
}

function buildTimingChecks(designSummary, reportKind) {
  const hasValue = (v) => v !== null && v !== undefined;
  const noFailing = (v) => v === null || v === undefined || v === 0;
  const checks = {
    setup: {
      analyzed: !!designSummary && hasValue(designSummary.wns),
      met: null,
      wns: designSummary?.wns ?? null,
      tns: designSummary?.tns ?? null,
      failingEndpoints: designSummary?.tnsFailingEndpoints ?? null,
    },
    hold: {
      analyzed: !!designSummary && hasValue(designSummary.whs),
      met: null,
      whs: designSummary?.whs ?? null,
      ths: designSummary?.ths ?? null,
      failingEndpoints: designSummary?.thsFailingEndpoints ?? null,
    },
    pulseWidth: {
      analyzed: !!designSummary && hasValue(designSummary.wpws),
      met: null,
      wpws: designSummary?.wpws ?? null,
      tpws: designSummary?.tpws ?? null,
      failingEndpoints: designSummary?.tpwsFailingEndpoints ?? null,
    },
  };
  if (checks.setup.analyzed) checks.setup.met = designSummary.wns >= 0 && noFailing(designSummary.tnsFailingEndpoints);
  if (checks.hold.analyzed) checks.hold.met = designSummary.whs >= 0 && noFailing(designSummary.thsFailingEndpoints);
  if (checks.pulseWidth.analyzed) checks.pulseWidth.met = designSummary.wpws >= 0 && noFailing(designSummary.tpwsFailingEndpoints);
  if (reportKind === 'max') checks.hold.analyzed = false;
  return checks;
}

/**
 * 旧键兼容别名：把 "WNS(ns)" 等 2018.3 表头字符串挂到 designSummary 上。
 * Round 4 起主契约为 camelCase（wns/tns/...），但为了不破坏既有调用方（含插件 JSON 无损化、
 * 旧脚本/旧文档按旧键取值），这些别名保持 enumerable，会随 structuredContent JSON 一起返回；
 * 后续等所有消费方切到 camelCase 后可改为非枚举或删除。
 */
function attachLegacyTimingAliases(designSummary) {
  if (!designSummary) return;
  for (const { key, label } of TIMING_NUMERIC_COLUMNS) {
    const value = designSummary[key];
    if (value === null || value === undefined) continue;
    try {
      Object.defineProperty(designSummary, label, { value, enumerable: true, configurable: true, writable: false });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 解析 report_timing_summary 文本（max / min_max）。
 * 返回契约见 tools/vivado-mcp/SPEC_round4_timing.md §2。
 */
export function parseTiming(text) {
  const lines = splitLines(text);
  const result = {
    hasReport: false,
    toolVersion: null,
    reportKind: 'unknown',
    timingScope: null,
    designSummary: null,
    intraClock: [],
    interClock: [],
    otherPathGroups: [],
    checks: null,
    constraintsMet: null,
    notes: [],
  };
  if (!text) return result;
  const hasWnsHeader = lines.some((l) => /WNS\(ns\)/.test(l));
  const hasHoldColumns = lines.some((l) => /WHS\(ns\)/.test(l) && /THS\(ns\)/.test(l));
  if (!hasWnsHeader && !/report_timing_summary/i.test(text)) return result;
  result.hasReport = hasWnsHeader;
  if (!result.hasReport) {
    result.notes.push('文本提到 report_timing_summary，但未找到 WNS(ns) 表头（报告可能为空或格式不同）');
    return result;
  }
  const versionLine = lines.find((l) => /Tool Version\s*:/i.test(l));
  if (versionLine) result.toolVersion = (/(?:Tool Version\s*:\s*)(.+)$/i.exec(versionLine) || [])[1]?.trim() || versionLine.trim();
  result.reportKind = hasHoldColumns ? 'min_max' : 'max';
  result.timingScope = result.reportKind === 'min_max' ? 'setup+hold+pw' : 'setup+pw';

  const designHeader = findTimingTableHeader(lines, 'Design Timing Summary', ['WNS(ns)']);
  const intraHeader = findTimingTableHeader(lines, 'Intra Clock Table', ['WNS(ns)', 'WPWS(ns)']);
  const interHeader =
    findTimingTableHeader(lines, 'Inter Clock Table', ['From Clock', 'To Clock', 'WNS(ns)']) >= 0
      ? findTimingTableHeader(lines, 'Inter Clock Table', ['From Clock', 'To Clock', 'WNS(ns)'])
      : findTimingTableHeader(lines, 'Inter Clock Table', ['Source Clock', 'Destination Clock', 'WNS(ns)']);
  const otherHeader = findTimingTableHeader(lines, 'Other Path Groups Table', ['Path Group', 'WNS(ns)']);

  if (designHeader >= 0) {
    const columns = parseTimingHeaderColumns(lines[designHeader]);
    const rows = collectTimingRows(lines, designHeader);
    if (rows.length > 0) {
      const parsed = parseTimingRowByColumns(rows[0], columns);
      // Design Summary 只保留数值列（该表没有 name 列）
      const summary = {};
      for (const column of columns) if (column.type === 'number') summary[column.key] = parsed[column.key];
      result.designSummary = summary;
      attachLegacyTimingAliases(summary);
    }
  }
  if (intraHeader >= 0) {
    const columns = parseTimingHeaderColumns(lines[intraHeader]);
    for (const rowLine of collectTimingRows(lines, intraHeader)) {
      const row = parseTimingRowByColumns(rowLine, columns);
      if (!row.clock && Object.values(row).every((v) => v === null)) continue;
      result.intraClock.push(row);
    }
  }
  if (interHeader >= 0) {
    const columns = parseTimingHeaderColumns(lines[interHeader]);
    for (const rowLine of collectTimingRows(lines, interHeader)) {
      const row = parseTimingRowByColumns(rowLine, columns);
      if (!row.fromClock && Object.values(row).every((v) => v === null)) continue;
      result.interClock.push(row);
    }
  }
  if (otherHeader >= 0) {
    const columns = parseTimingHeaderColumns(lines[otherHeader]);
    for (const rowLine of collectTimingRows(lines, otherHeader)) {
      const row = parseTimingRowByColumns(rowLine, columns);
      if (!row.pathGroup && Object.values(row).every((v) => v === null)) continue;
      result.otherPathGroups.push(row);
    }
  }

  if (result.designSummary) {
    result.checks = buildTimingChecks(result.designSummary, result.reportKind);
  }
  if (/All user specified timing constraints are met/i.test(text)) result.constraintsMet = true;
  else if (/Timing constraints are not met/i.test(text)) result.constraintsMet = false;

  if (!result.designSummary) {
    result.notes.push('检测到时序报告但未解析到 Design Timing Summary 表（报告可能为空或格式不同）');
  } else if (result.reportKind === 'max') {
    result.notes.push('报告为 -delay_type max：hold（WHS/THS）未分析，判定范围=setup+pulseWidth');
  } else {
    result.notes.push('报告为 -delay_type min_max：含 hold（WHS/THS）分析');
  }
  const onlyPulseWidth = result.intraClock.filter((row) => row.wns === null && (row.wpws !== null || row.tpws !== null));
  if (onlyPulseWidth.length > 0) {
    result.notes.push(`Intra Clock Table 中 ${onlyPulseWidth.length} 个时钟的 WNS/TNS 为空列（仅 pulse-width 数据），已保留 null 而非用 WPWS 填充`);
  }
  if (interHeader >= 0 && result.interClock.length === 0) result.notes.push('Inter Clock Table 为空（无跨时钟路径）');
  if (otherHeader >= 0 && result.otherPathGroups.length === 0) result.notes.push('Other Path Groups Table 为空');
  return result;
}

// ---------------------------------------------------------------------------
// Bus Skew 报告（report_bus_skew）
// ---------------------------------------------------------------------------

/**
 * 解析 report_bus_skew 文本。
 * 返回 { hasReport, applicable, constraints, worstSlackNs, met, rows, notes }。
 */
export function parseBusSkew(text) {
  const result = { hasReport: false, applicable: false, constraints: null, worstSlackNs: null, met: null, rows: [], notes: [] };
  if (!text) return result;
  const lines = splitLines(text);
  const signature = lines.some((l) => /Bus Skew Report/i.test(l)) || lines.some((l) => /report_bus_skew/i.test(l));
  if (!signature) return result;
  result.hasReport = true;

  // 注意：报告开头有 Table of Contents（同样含 "1. Bus Skew Report Summary" 字样），
  // 因此直接定位真正的表头行（Requirement/Slack 列），再取到 "2. Bus Skew Report Per Constraint" 之前。
  const summaryHeaderIndex = lines.findIndex((l) => /Requirement\(ns\)/.test(l) && /Slack\(ns\)/.test(l));
  const summaryEndIndex = lines.findIndex((l, index) => index > summaryHeaderIndex && /Bus Skew Report Per Constraint/i.test(l));
  const summaryLines = summaryHeaderIndex >= 0 ? lines.slice(summaryHeaderIndex + 1, summaryEndIndex > summaryHeaderIndex ? summaryEndIndex : lines.length) : [];
  if (summaryHeaderIndex >= 0) {
    const headerLine = lines[summaryHeaderIndex];
    const columnDefs = ['Requirement(ns)', 'Actual(ns)', 'Slack(ns)']
      .map((label) => ({ label, start: headerLine.indexOf(label) }))
      .filter((column) => column.start >= 0)
      .sort((a, b) => a.start - b.start);
    const reqColumn = columnDefs.find((c) => c.label === 'Requirement(ns)');
    const actualColumn = columnDefs.find((c) => c.label === 'Actual(ns)');
    const slackColumn = columnDefs.find((c) => c.label === 'Slack(ns)');
    const columnValue = (line, column) => {
      if (!column) return null;
      const next = columnDefs.find((c) => c.start > column.start);
      const raw = line.slice(column.start, next ? next.start : line.length).trim();
      return raw === '' || /^NA$/i.test(raw) ? null : toNumber(raw);
    };
    // Summary 每行可能由多行组成（From/To 是 get_cells 列表，右侧数值在最后一行）：
    // 以 "id  position" 行划分 block，取 block 内最后一行能解析出 Slack 的行。
    let block = null;
    const flushBlock = () => {
      if (!block) return;
      const idMatch = /^\s*(\d+)\s+(\d+)\s/.exec(block.lines[0] || '');
      for (let i = block.lines.length - 1; i >= 0; i--) {
        const line = block.lines[i];
        const slackNs = columnValue(line, slackColumn);
        if (slackNs === null) continue;
        result.rows.push({
          id: idMatch ? Number(idMatch[1]) : null,
          position: idMatch ? Number(idMatch[2]) : null,
          requirementNs: columnValue(line, reqColumn),
          actualNs: columnValue(line, actualColumn),
          slackNs,
        });
        break;
      }
      block = null;
    };
    for (let i = 0; i < summaryLines.length; i++) {
      const line = summaryLines[i];
      if (/^\s*\d+\s+\d+\s/.test(line)) {
        flushBlock();
        block = { lines: [line] };
      } else if (block && line.trim()) {
        block.lines.push(line);
      }
    }
    flushBlock();
  }
  if (result.rows.length === 0) {
    // 兜底：从 Per Constraint 的 "Slack (MET/VIOLATED) : xx.xxxns" 行提取
    const slackValues = [];
    for (const line of lines) {
      const matched = /^\s*Slack\s+\((?:MET|VIOLATED)\)\s*:\s*(-?\d+(?:\.\d+)?)ns/i.exec(line);
      if (matched) slackValues.push(Number(matched[1]));
    }
    if (slackValues.length > 0) {
      for (const value of slackValues) result.rows.push({ id: null, position: null, requirementNs: null, actualNs: null, slackNs: value });
    }
  }
  result.constraints = result.rows.length;
  if (result.rows.length > 0) {
    result.applicable = true;
    const slacks = result.rows.map((row) => row.slackNs).filter((v) => v !== null && v !== undefined);
    result.worstSlackNs = slacks.length > 0 ? Math.min(...slacks) : null;
    result.met = result.worstSlackNs === null ? null : result.worstSlackNs >= 0;
    result.notes.push(`解析到 ${result.constraints} 条 bus skew 约束，最差 slack=${result.worstSlackNs}ns（${result.met ? 'MET' : 'VIOLATED'}）`);
  } else {
    result.applicable = false;
    if (/No bus skew constraints/i.test(text)) {
      result.notes.push('No bus skew constraints（报告中无 bus skew 约束，applicable=false）');
    } else {
      result.notes.push('报告中未发现 bus skew 约束（applicable=false；可能没有 set_bus_skew 约束或未生成约束）');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 资源利用率报告（report_utilization）
// ---------------------------------------------------------------------------

const UTIL_NAME_MAP = {
  lut: ['Slice LUTs', 'CLB LUTs'],
  lutLogic: ['LUT as Logic', 'CLB LUTs'],
  lutMemory: ['LUT as Memory'],
  ff: ['Slice Registers', 'CLB Registers'],
  registerFlop: ['Register as Flip Flop'],
  registerLatch: ['Register as Latch'],
  bram: ['Block RAM Tile'],
  bram36: ['RAMB36/FIFO'],
  bram18: ['RAMB18/FIFO'],
  dsp: ['DSPs'],
  iob: ['Bonded IOB'],
  bufg: ['BUFGCTRL'],
  mmcm: ['MMCME2_ADV'],
  pll: ['PLLE2_ADV'],
  gt: ['GTXE2_CHANNEL'],
};

function parseTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const parts = trimmed.split('|');
  if (parts.length < 3) return null;
  const cells = parts.slice(1, -1).map((s) => s.trim());
  if (cells.every((c) => /^[-+]*$/.test(c))) return null;
  return cells;
}

/** 解析 report_utilization 文本（按表头动态映射列，兼容 2018.3 的 4 数值列格式） */
export function parseUtilization(text) {
  const rows = [];
  const lines = splitLines(text);
  let header = null;
  for (const line of lines) {
    const cells = parseTableCells(line);
    if (!cells || cells.length < 2) continue;
    // 表头：| Site Type | Used | Fixed | Available | Util% |
    if (!header && cells.some((c) => /^Site Type$/i.test(c)) && cells.some((c) => /^Used$/i.test(c))) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    const name = cells[0];
    if (!name || /^Site Type$/i.test(name) || /^Name$/i.test(name)) continue;
    const used = toNumber(cells[1]);
    if (used === null) continue; // 表头/说明行
    const row = { name, used, fixed: null, prohibited: null, available: null, utilPercent: null, extra: {}, raw: line.trim() };
    if (header) {
      for (let i = 1; i < cells.length; i++) {
        const column = header[i] || `col${i}`;
        const value = cells[i];
        if (column === 'used') row.used = toNumber(value) ?? row.used;
        else if (column === 'fixed') row.fixed = toNumber(value);
        else if (column === 'prohibited') row.prohibited = toNumber(value);
        else if (column === 'available') row.available = toNumber(value);
        else if (/util/.test(column)) row.utilPercent = toNumber(String(value).replace('%', ''));
        else row.extra[column] = value;
      }
    } else {
      // 兜底：旧格式 | Site Type | Used | Fixed | Prohibited | Available | Util% |
      row.fixed = toNumber(cells[2]);
      if (cells.length >= 6) {
        row.prohibited = toNumber(cells[3]);
        row.available = toNumber(cells[4]);
        row.utilPercent = toNumber(String(cells[5] ?? '').replace('%', ''));
      } else {
        row.available = toNumber(cells[3]);
        row.utilPercent = toNumber(String(cells[4] ?? '').replace('%', ''));
      }
    }
    rows.push(row);
  }
  const summary = {};
  for (const [key, names] of Object.entries(UTIL_NAME_MAP)) {
    for (const name of names) {
      const row = rows.find((r) => r.name === name);
      if (row) {
        summary[key] = { used: row.used, available: row.available, utilPercent: row.utilPercent, name: row.name };
        break;
      }
    }
  }
  return { hasReport: rows.length > 0, rows, summary, toolVersion: (lines.find((l) => /Tool Version/i.test(l)) || '').trim() || null };
}

// ---------------------------------------------------------------------------
// 功耗报告（report_power）
// ---------------------------------------------------------------------------

function findValueByName(cells) {
  // cells: [name, value, ...]
  if (!cells || cells.length < 2) return null;
  return toNumber(cells[1]);
}

/** 解析 report_power 文本 */
export function parsePower(text) {
  const result = {
    hasReport: false,
    totalOnChipW: null,
    dynamicW: null,
    deviceStaticW: null,
    junctionTempC: null,
    thermalMarginC: null,
    confidence: null,
    summaryLine: null,
    rows: [],
  };
  const lines = splitLines(text);
  for (const line of lines) {
    const cells = parseTableCells(line);
    if (cells && cells.length >= 2) {
      const name = cells[0];
      const value = cells[1];
      result.rows.push({ name, value, raw: line.trim() });
      if (/^Total On-Chip Power/i.test(name)) result.totalOnChipW = toNumber(value);
      else if (/^Dynamic\b/i.test(name)) result.dynamicW = toNumber(value);
      else if (/^Device Static/i.test(name)) result.deviceStaticW = toNumber(value);
      else if (/Junction Temperature/i.test(name)) result.junctionTempC = toNumber(value);
      else if (/Thermal Margin/i.test(name)) result.thermalMarginC = toNumber(value);
      else if (/^Confidence level/i.test(name)) result.confidence = String(value).trim();
    }
    // "Confidence level: Low" 这类非表格行
    let m = /Confidence\s+level\s*:\s*(\w+)/i.exec(line);
    if (m) result.confidence = m[1];
    m = /Total On-Chip Power\s*\(W\)\s*:\s*([\d.]+)/i.exec(line);
    if (m && result.totalOnChipW === null) result.totalOnChipW = toNumber(m[1]);
    if (/Design Power \(W\)|Power analysis/i.test(line) && !result.summaryLine) result.summaryLine = line.trim();
  }
  result.hasReport =
    result.totalOnChipW !== null || result.dynamicW !== null || lines.some((l) => /report_power|On-Chip Power/i.test(l));
  return result;
}

// ---------------------------------------------------------------------------
// 仿真结果
// ---------------------------------------------------------------------------

const PASS_RE = /^\s*\[PASS\]\s*(.*)$/;
const FAIL_RE = /^\s*\[FAIL\]\s*(.*)$/;
// xsim 运行期 $error / $fatal 打印为 "Error: ..."（大小写都可能），Vivado 工具错误是 "ERROR:"；
// 这里都按运行时错误收集，退出码 0 不能代表测试通过。
const SIM_RUNTIME_ERROR_RE = /^\s*(?:ERROR|Error|FATAL|Fatal)\s*:\s*(.*)$/;
const SIM_WARNING_RE = /^\s*(?:WARNING|Warning)\s*:\s*(.*)$/;

/** 从 "label: timeout waiting for o_dv assertion" 里取用例 label（没有冒号则整句） */
export function extractSimErrorLabel(message) {
  const s = String(message || '').trim();
  const m = /^([^:：]{1,120})[:：]/.exec(s);
  return m ? m[1].trim() : s.slice(0, 120);
}

/** 解析仿真日志的 PASS/ERROR 统计（退出码 0 也要以日志标记为准） */
export function parseSimResult(text) {
  const passLabels = [];
  const failLabels = [];
  const errors = [];
  const errorLabels = [];
  const warnings = [];
  const seen = new Set();
  let finished = false;
  for (const line of splitLines(text)) {
    let m = PASS_RE.exec(line);
    if (m) {
      passLabels.push(m[1].trim());
      continue;
    }
    m = FAIL_RE.exec(line);
    if (m) {
      failLabels.push(m[1].trim());
      continue;
    }
    const err = SIM_RUNTIME_ERROR_RE.exec(line);
    if (err) {
      const message = err[1].trim();
      const key = message.slice(0, 200);
      if (message && !seen.has(key) && errors.length < MAX_COLLECTED) {
        seen.add(key);
        errorLabels.push(extractSimErrorLabel(message));
        errors.push({ severity: 'ERROR', message: message.slice(0, 500), raw: line.trim().slice(0, 800) });
      }
      continue;
    }
    const warn = SIM_WARNING_RE.exec(line);
    if (warn) {
      const message = warn[1].trim();
      if (message && warnings.length < MAX_COLLECTED) warnings.push({ severity: 'WARNING', message: message.slice(0, 500), raw: line.trim().slice(0, 800) });
      continue;
    }
    if (/XSim simulation ran for|XSim completed|INFO: \[USR-XSim-96\]|\$finish|All .* tests? completed/i.test(line)) finished = true;
  }
  const errorCount = errors.length;
  return {
    passCount: passLabels.length,
    passLabels,
    failCount: failLabels.length,
    failLabels,
    errorCount,
    errorLabels: [...new Set(errorLabels)],
    errors,
    warnings,
    finished,
    ok: errorCount === 0 && failLabels.length === 0 && passLabels.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 位流文件信息（纯文本/数字部分，文件系统信息在 reports.mjs）
// ---------------------------------------------------------------------------

/** 从 bit 文件路径/大小构造摘要 */
export function describeBitFile({ path: bitPath, size } = {}) {
  if (!bitPath) return null;
  return { path: bitPath, size: Number(size) || 0, present: (Number(size) || 0) > 0 };
}
