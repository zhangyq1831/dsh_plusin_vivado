// 工程侧解析：直接读 Vivado .xpr（XML）拿到器件/顶层/文件集/runs/仿真集，不启动 Vivado。
import fs from 'node:fs';
import path from 'node:path';
import {
  createProjectContext,
  findXprInDir,
  resolveProject,
} from './config.mjs';
import { envError } from './errors.mjs';
import {
  formatDurationMs,
  humanBytes,
  listDirSafe,
  pathExists,
  readTail,
  readTextFile,
  readTextFileOrNull,
  statOrNull,
  tailLines,
} from './util.mjs';
import {
  findChild,
  findChildren,
  findAll,
  getAttr,
  getText,
  optionValues,
  optionsToObject,
  parseXml,
} from './xml.mjs';
import { parseProgress } from './parse.mjs';

// ---------------------------------------------------------------------------
// Source 文件模块扫描（简单的 Verilog/SystemVerilog 正则，不做完整语法分析）
// ---------------------------------------------------------------------------

const MODULE_DECL_RE = /^\s*module\s+([A-Za-z_$][\w$]*)/gm;
const moduleCache = new Map(); // key: `${path}:${mtimeMs}:${size}` -> [moduleName]

/** 从文本提取 module 名（跳过注释里的伪 module） */
export function extractModules(text) {
  if (!text) return [];
  // 去注释，避免 `// module fake;` 干扰
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const names = [];
  MODULE_DECL_RE.lastIndex = 0;
  let m;
  while ((m = MODULE_DECL_RE.exec(stripped))) names.push(m[1]);
  return [...new Set(names)];
}

/** 提取某文件的 module 清单（带 mtime 缓存） */
async function modulesOfFile(filePath) {
  const stat = await statOrNull(filePath);
  if (!stat) return [];
  const key = `${filePath}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  if (moduleCache.has(key)) return moduleCache.get(key);
  const text = (await readTextFileOrNull(filePath)) || '';
  const mods = extractModules(text);
  moduleCache.set(key, mods);
  return mods;
}

const SOURCE_EXT = new Set(['.v', '.sv', '.vh', '.svh', '.vhd', '.vhdl']);
const HDL_SOURCE_EXT = new Set(['.v', '.sv', '.vhd', '.vhdl']);

function isHdlSource(filePath) {
  return HDL_SOURCE_EXT.has(path.extname(filePath).toLowerCase());
}

function isSourceLike(filePath) {
  return SOURCE_EXT.has(path.extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// xpr 解析
// ---------------------------------------------------------------------------

function expandMacro(raw, ctx) {
  if (!raw) return raw;
  let out = String(raw);
  const macros = [
    ['$PPRDIR', ctx.projectDir],
    ['$PSRCDIR', ctx.srcsDir],
    ['$PRUNDIR', ctx.runsDir],
    ['$PCACHEDIR', ctx.cacheDir],
    ['$PIPUSERFILESDIR', ctx.ipUserFilesDir],
    ['$PGENERATED', ctx.projectDir],
    ['$PROJECTDIR', ctx.projectDir],
  ];
  for (const [name, value] of macros) {
    if (out.startsWith(name)) out = value + out.slice(name.length);
    else out = out.split(name).join(value);
  }
  return path.normalize(out);
}

function kindOfRunType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (t.includes('synth')) return 'synth';
  if (t.includes('entiredesign') || t.includes('impl')) return 'impl';
  return 'other';
}

/**
 * 解析 .xpr 文档（纯读取，不启动 Vivado）
 * @param {string} xprPath
 * @param {ReturnType<typeof createProjectContext>} [ctx]
 */
export function parseXpr(xprPath, ctx) {
  const document = parseXprSync(xprPath);
  return document;
}

function parseXprSync(xprPath, ctxInput) {
  const projectDir = path.dirname(path.resolve(xprPath));
  const source = readTextFileOrNullSyncSafe(xprPath);
  if (source == null) {
    throw envError(`无法读取工程文件：${xprPath}`, '检查文件是否存在/可读。');
  }
  const context = ctxInput || createProjectContext(projectDir, xprPath);
  const doc = parseXml(source);
  const project = findChild(doc, 'Project');
  if (!project) throw envError(`不是有效的 Vivado 工程文件（缺少 <Project> 根元素）：${xprPath}`);

  const configuration = findChild(project, 'Configuration');
  const config = optionsToObject(configuration);

  const fileSetsNode = findChild(project, 'FileSets');
  const fileSets = [];
  for (const setNode of findChildren(fileSetsNode, 'FileSet')) {
    const setConfigNode = findChild(setNode, 'Config');
    const setConfig = optionsToObject(setConfigNode);
    const files = [];
    for (const fileNode of findChildren(setNode, 'File')) {
      const rawPath = getAttr(fileNode, 'Path') || '';
      const absPath = expandMacro(rawPath, context);
      const infoNode = findChild(fileNode, 'FileInfo');
      const usedIn =
        infoNode == null
          ? []
          : findAll(infoNode, 'Attr')
              .filter((a) => getAttr(a, 'Name') === 'UsedIn')
              .map((a) => getAttr(a, 'Val'));
      files.push({
        rawPath,
        path: absPath,
        name: path.basename(absPath),
        ext: path.extname(absPath).toLowerCase(),
        usedIn,
        importPath: infoNode
          ? (findAll(infoNode, 'Attr').find((a) => getAttr(a, 'Name') === 'ImportPath') || {}).attrs?.Val || null
          : null,
      });
    }
    fileSets.push({
      name: getAttr(setNode, 'Name') || '',
      type: getAttr(setNode, 'Type') || '',
      relSrcDir: getAttr(setNode, 'RelSrcDir') || '',
      config: setConfig,
      // 多个 XSimWcfgFile（波形配置文件）——可能来自其它机器，仅用于 doctor 的已知噪音提示
      wcfgFilesRaw: optionValues(setConfigNode, 'XSimWcfgFile'),
      files,
    });
  }

  const runsNode = findChild(project, 'Runs');
  const runs = [];
  for (const runNode of findChildren(runsNode, 'Run')) {
    const dirRaw = getAttr(runNode, 'Dir') || '';
    const incrRaw = getAttr(runNode, 'IncrementalCheckpoint') || '';
    const incrPath = incrRaw ? expandMacro(incrRaw, context) : null;
    const strategyNode = findChild(runNode, 'Strategy');
    runs.push({
      id: getAttr(runNode, 'Id') || '',
      rawType: getAttr(runNode, 'Type') || '',
      kind: kindOfRunType(getAttr(runNode, 'Type')),
      srcSet: getAttr(runNode, 'SrcSet') || null,
      part: getAttr(runNode, 'Part') || null,
      constrsSet: getAttr(runNode, 'ConstrsSet') || null,
      description: getAttr(runNode, 'Description') || null,
      state: getAttr(runNode, 'State') || null,
      current: getAttr(runNode, 'State') === 'current',
      synthRun: getAttr(runNode, 'SynthRun') || null,
      incrementalCheckpoint: incrPath ? { raw: incrRaw, path: incrPath } : null,
      dir: dirRaw ? expandMacro(dirRaw, context) : path.join(context.runsDir, getAttr(runNode, 'Id') || ''),
      steps: strategyNode
        ? findAll(strategyNode, 'Step').map((s) => getAttr(s, 'Id')).filter(Boolean)
        : [],
    });
  }

  const simulators = [];
  const simulatorsNode = findChild(project, 'Simulators');
  for (const sim of findChildren(simulatorsNode, 'Simulator')) {
    simulators.push({ name: getAttr(sim, 'Name') || '', options: optionsToObject(sim) });
  }

  return {
    xprPath: path.resolve(xprPath),
    projectDir,
    xprBase: path.basename(path.resolve(xprPath), '.xpr'),
    projectVersion: getAttr(project, 'Version') || null,
    declaredProjectPath: getAttr(project, 'Path') || null,
    part: config.Part || null,
    boardPart: config.BoardPart || null,
    projectType: config.ProjectType || null,
    activeSimSet: config.ActiveSimSet || null,
    defaultLib: config.DefaultLib || null,
    simTypes: optionValues(configuration, 'SimTypes'),
    config,
    fileSets,
    runs,
    simulators,
    context,
  };
}

function readTextFileOrNullSyncSafe(p) {
  try {
    // 同步读取（xpr 只有几十 KB）
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 找到 DesignSrcs / SimulationSrcs / Constrs 文件集 */
export function pickFileSet(parsed, { type, name } = {}) {
  if (name) return parsed.fileSets.find((s) => s.name === name) || null;
  if (type) {
    if (type === 'design') return parsed.fileSets.find((s) => s.type === 'DesignSrcs') || null;
    if (type === 'sim') return parsed.fileSets.find((s) => s.type === 'SimulationSrcs') || null;
    if (type === 'constrs') return parsed.fileSets.find((s) => s.type === 'Constrs') || null;
    return parsed.fileSets.find((s) => s.type === type) || null;
  }
  return null;
}

/** 设计顶层：DesignSrcs 文件集的 Config.TopModule */
export function designTop(parsed) {
  const designSet = pickFileSet(parsed, { type: 'design' });
  return designSet?.config?.TopModule || null;
}

/** 仿真顶层：ActiveSimSet 文件集的 Config.TopModule */
export function simTop(parsed) {
  const activeSetName = parsed.activeSimSet;
  const simSet =
    (activeSetName && parsed.fileSets.find((s) => s.name === activeSetName)) ||
    pickFileSet(parsed, { type: 'sim' });
  return simSet?.config?.TopModule || null;
}

export function designFileSet(parsed) {
  return pickFileSet(parsed, { type: 'design' });
}

export function simFileSet(parsed) {
  const activeSetName = parsed.activeSimSet;
  return (
    (activeSetName && parsed.fileSets.find((s) => s.name === activeSetName)) ||
    pickFileSet(parsed, { type: 'sim' })
  );
}

export function constrsFileSet(parsed) {
  return pickFileSet(parsed, { type: 'constrs' });
}

export function currentRuns(parsed) {
  return {
    synth: parsed.runs.find((r) => r.kind === 'synth' && r.current) || null,
    impl: parsed.runs.find((r) => r.kind === 'impl' && r.current) || null,
  };
}

// ---------------------------------------------------------------------------
// run 目录状态检查
// ---------------------------------------------------------------------------

/** 在 run 目录里找顶层产物 */
async function inspectRunArtifacts(runDir) {
  const entries = await listDirSafe(runDir);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const p = path.join(runDir, entry.name);
    const stat = await statOrNull(p);
    files.push({ name: entry.name, path: p, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0 });
  }
  const byExt = (ext) => files.filter((f) => f.name.toLowerCase().endsWith(ext));
  const has = (name) => files.some((f) => f.name === name);
  return { files, dcp: byExt('.dcp'), bit: byExt('.bit'), rpt: byExt('.rpt'), has, runmeLog: has('runme.log') ? path.join(runDir, 'runme.log') : null };
}

/**
 * run 状态：从 run 目录里的完成标记 / 日志 / 产物推断（不打开工程）
 * status: not_started | incomplete | complete | unknown
 */
async function inspectRun(run) {
  const runDir = run.dir;
  const dirStat = await statOrNull(runDir);
  if (!dirStat || !dirStat.isDirectory()) {
    return {
      id: run.id,
      kind: run.kind,
      part: run.part,
      current: run.current,
      state: run.state,
      synthRun: run.synthRun,
      runDir,
      dirExists: false,
      status: 'not_started',
      progress: null,
      lastLogLine: null,
      artifacts: { dcp: [], bit: [], report: [] },
      incrementalCheckpoint: run.incrementalCheckpoint,
    };
  }
  const art = await inspectRunArtifacts(runDir);
  let logTail = '';
  if (art.runmeLog) logTail = await readTail(art.runmeLog, 64 * 1024);
  const completedMarkers = [];
  if (run.kind === 'synth') {
    if (art.has('__synthesis_is_complete__')) completedMarkers.push('__synthesis_is_complete__');
    if (/synth_design completed successfully/i.test(logTail)) completedMarkers.push('synth_design completed successfully');
    if (art.dcp.length > 0 && /Exiting Vivado/i.test(logTail)) completedMarkers.push('dcp+Exiting Vivado');
  } else if (run.kind === 'impl') {
    if (art.files.some((f) => /_routed\.dcp$/i.test(f.name))) completedMarkers.push('routed dcp');
    if (/write_bitstream completed successfully/i.test(logTail)) completedMarkers.push('write_bitstream completed successfully');
    if (/route_design completed successfully/i.test(logTail)) completedMarkers.push('route_design completed successfully');
  }
  const isComplete =
    completedMarkers.length > 0 ||
    art.has('.vivado.end.rst') ||
    (run.kind === 'synth' && art.dcp.length > 0 && art.bit.length === 0 && /Exiting Vivado/i.test(logTail));
  const status = isComplete ? 'complete' : art.runmeLog ? 'incomplete' : 'unknown';
  const progressInfo = parseProgress(logTail);
  const lastLine = tailLines(logTail, 1).join('').trim() || null;
  return {
    id: run.id,
    kind: run.kind,
    rawType: run.rawType,
    part: run.part,
    current: run.current,
    state: run.state,
    synthRun: run.synthRun,
    runDir,
    dirExists: true,
    status,
    completedMarkers,
    progress: isComplete ? 100 : progressInfo.percent,
    lastLogLine: lastLine,
    logUpdatedAt: art.runmeLog ? (await statOrNull(art.runmeLog))?.mtimeMs || null : null,
    artifacts: {
      dcp: art.dcp.map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs })),
      bit: art.bit.map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs })),
      report: art.rpt.map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs })),
    },
    incrementalCheckpoint: run.incrementalCheckpoint
      ? { ...run.incrementalCheckpoint, exists: await pathExists(run.incrementalCheckpoint.path) }
      : null,
  };
}

export async function inspectRuns(parsed) {
  const out = [];
  for (const run of parsed.runs) out.push(await inspectRun(run));
  return out;
}

// ---------------------------------------------------------------------------
// 最近产物 / xpr 备份
// ---------------------------------------------------------------------------

async function walkFiles(dir, { maxDepth = 2, filter, limit = 200 } = {}) {
  const out = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const { dir: current, depth } = queue.shift();
    const entries = await listDirSafe(current);
    for (const entry of entries) {
      if (out.length >= limit) break;
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ dir: p, depth: depth + 1 });
        continue;
      }
      if (filter && !filter(entry.name, p)) continue;
      const stat = await statOrNull(p);
      out.push({ path: p, name: entry.name, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0 });
    }
  }
  return out;
}

/** 最近产物（runs 目录下 .bit/.dcp/.rpt + .vivado-mcp 报告） */
export async function recentArtifacts(ctx, limit = 12) {
  const fromRuns = await walkFiles(ctx.runsDir, {
    maxDepth: 2,
    filter: (name) => /\.(bit|dcp|rpt)$/i.test(name),
    limit: 200,
  });
  const fromReports = await walkFiles(ctx.reportsDir, {
    maxDepth: 2,
    filter: (name) => /\.(rpt|log|txt)$/i.test(name),
    limit: 100,
  });
  const merged = [...fromRuns, ...fromReports].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  const bit = merged.find((f) => /\.bit$/i.test(f.name));
  return {
    recent: merged.map((f) => ({
      path: f.path,
      relative: path.relative(ctx.projectDir, f.path),
      size: f.size,
      sizeHuman: humanBytes(f.size),
      mtime: new Date(f.mtimeMs).toISOString(),
    })),
    latestBit: bit
      ? { path: bit.path, size: bit.size, sizeHuman: humanBytes(bit.size), mtime: new Date(bit.mtimeMs).toISOString() }
      : null,
  };
}

/** 已有 xpr 备份 */
export async function listXprBackups(ctx, limit = 10) {
  const entries = await listDirSafe(ctx.backupDir);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(ctx.backupDir, entry.name);
    const stat = await statOrNull(dir);
    dirs.push({ dir, name: entry.name, mtimeMs: stat ? stat.mtimeMs : 0 });
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const item of dirs.slice(0, limit)) {
    const files = await listDirSafe(item.dir);
    out.push({
      dir: item.dir,
      name: item.name,
      mtime: new Date(item.mtimeMs).toISOString(),
      files: files.filter((f) => f.isFile()).map((f) => f.name),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工程信息汇总
// ---------------------------------------------------------------------------

/**
 * 工程信息（vivado_project_info / CLI info）
 */
export async function getProjectInfo({ projectDir, env = process.env, cwd = process.cwd() } = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd });
  const parsed = parseXpr(resolved.xprPath, createProjectContext(resolved.projectDir, resolved.xprPath));
  const ctx = parsed.context;
  const xprStat = await statOrNull(ctx.xprPath);

  const designSet = designFileSet(parsed);
  const simSet = simFileSet(parsed);
  const constrsSet = constrsFileSet(parsed);

  const decorateFiles = async (files) => {
    const out = [];
    for (const f of files) {
      const stat = await statOrNull(f.path);
      out.push({ path: f.path, relative: path.relative(ctx.projectDir, f.path), exists: !!stat, size: stat ? stat.size : 0 });
    }
    return out;
  };

  const designSourcesAll = designSet ? designSet.files : [];
  const designSources = designSourcesAll.filter((f) => isSourceLike(f.path));
  const simFilesAll = simSet ? simSet.files : [];
  const simSources = simFilesAll.filter((f) => isSourceLike(f.path));
  const constrsFiles = constrsSet ? constrsSet.files : [];

  const designSourceInfo = await decorateFiles(designSources);
  const constrsInfo = await decorateFiles(constrsFiles);
  const simInfo = await decorateFiles(simSources);

  const runs = await inspectRuns(parsed);
  const current = currentRuns(parsed);
  const artifacts = await recentArtifacts(ctx);
  const backups = await listXprBackups(ctx);

  return {
    ok: true,
    projectDir: ctx.projectDir,
    xpr: {
      path: ctx.xprPath,
      name: ctx.xprName,
      size: xprStat ? xprStat.size : 0,
      mtime: xprStat ? new Date(xprStat.mtimeMs).toISOString() : null,
      declaredPathInProject: parsed.declaredProjectPath,
      projectVersion: parsed.projectVersion,
      backupCount: backups.length,
      latestBackup: backups[0] || null,
    },
    part: parsed.part,
    boardPart: parsed.boardPart,
    projectType: parsed.projectType,
    design: {
      fileset: designSet ? designSet.name : null,
      top: designTop(parsed),
      sourceCount: designSources.length,
      sources: designSourceInfo,
      missing: designSourceInfo.filter((f) => !f.exists).map((f) => f.relative),
    },
    constraints: {
      fileset: constrsSet ? constrsSet.name : null,
      count: constrsInfo.length,
      files: constrsInfo,
      target: constrsSet ? constrsSet.config?.TargetConstrsFile || null : null,
      missing: constrsInfo.filter((f) => !f.exists).map((f) => f.relative),
    },
    sim: {
      set: parsed.activeSimSet,
      top: simTop(parsed),
      fileCount: simSources.length,
      mode: simSet ? simSet.config?.SimMode || null : null,
      srcSet: simSet ? simSet.config?.SrcSet || null : null,
      files: simInfo,
      missing: simInfo.filter((f) => !f.exists).map((f) => f.relative),
    },
    runs,
    currentRun: {
      synth: current.synth ? current.synth.id : null,
      impl: current.impl ? current.impl.id : null,
      implSynthRun: current.impl ? current.impl.synthRun : null,
    },
    artifacts,
    backups,
    runtimeDir: ctx.runtimeDir,
    jobsDir: ctx.jobsDir,
    reportsDir: ctx.reportsDir,
  };
}

// ---------------------------------------------------------------------------
// Testbench 列表与依赖检查
// ---------------------------------------------------------------------------

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Verilog/SV 关键字（做实例化启发式扫描时排除） */
const VERILOG_KEYWORDS = new Set(
  [
    'module', 'endmodule', 'macromodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'bit', 'byte', 'int',
    'integer', 'shortint', 'longint', 'real', 'realtime', 'time', 'parameter', 'localparam', 'defparam', 'assign',
    'always', 'always_ff', 'always_comb', 'always_latch', 'initial', 'final', 'if', 'else', 'case', 'casex', 'casez',
    'endcase', 'for', 'while', 'repeat', 'forever', 'do', 'function', 'endfunction', 'task', 'endtask', 'begin', 'end',
    'generate', 'endgenerate', 'genvar', 'typedef', 'struct', 'enum', 'union', 'packed', 'signed', 'unsigned',
    'automatic', 'static', 'const', 'ref', 'return', 'break', 'continue', 'default', 'posedge', 'negedge', 'edge',
    'and', 'or', 'not', 'xor', 'nand', 'nor', 'xnor', 'buf', 'supply0', 'supply1', 'tri', 'tri0', 'tri1', 'wand',
    'wor', 'interface', 'endinterface', 'modport', 'clocking', 'endclocking', 'package', 'endpackage', 'import',
    'export', 'property', 'endproperty', 'sequence', 'endsequence', 'assert', 'assume', 'cover', 'wait', 'fork',
    'join', 'join_any', 'join_none', 'disable', 'new', 'super', 'this', 'null', 'void', 'class', 'endclass', 'extends',
    'implements', 'virtual', 'pure', 'extern', 'local', 'protected', 'rand', 'randc', 'constraint', 'covergroup',
    'endgroup', 'specify', 'endspecify', 'primitive', 'endprimitive', 'table', 'endtable', 'config', 'endconfig',
    'liblist', 'cell', 'instance', 'use', 'timescale', 'include', 'define', 'undef', 'ifdef', 'ifndef', 'endif',
  ].map((k) => k.toLowerCase()),
);

/** Xilinx 原语/库单元：实例化它们不算“依赖缺失”（由 unisims_ver 等库提供） */
const XILINX_PRIMITIVE_PREFIXES = [
  'BUFG', 'BUFH', 'IBUF', 'OBUF', 'IOBUF', 'LUT', 'FD', 'MUXF', 'CARRY', 'DSP48', 'RAMB', 'RAM', 'ROM', 'MMCM',
  'PLL', 'IDDR', 'ODDR', 'ISERDES', 'OSERDES', 'GT', 'IBUFDS', 'OBUFDS', 'IBUFG', 'STARTUPE2', 'DNA_PORT', 'XADC',
  'ICAPE2', 'BSCANE2', 'SRL', 'AND2', 'OR2', 'XOR2', 'INV', 'GND', 'VCC', 'DCM', 'PMCD', 'CAPTURE', 'USR_ACCESSE2',
];

function isPrimitiveLike(name) {
  const upper = String(name || '').toUpperCase();
  return XILINX_PRIMITIVE_PREFIXES.some((p) => upper === p || upper.startsWith(p)) && /^[A-Z0-9_]+$/.test(String(name || ''));
}

/**
 * 扫描文本里的模块实例化（启发式，不依赖完整语法分析）：
 *  - `NAME #(...) inst (...)` 或 `NAME inst (...)`，排除关键字/任务调用/声明；
 *  - 返回候选类型名集合（去重）。
 * 注意：第二种形式必须要求 NAME 与实例名之间至少一个空白，否则正则会从
 * `dut_noparity (` 里回溯截出假的类型名 `dut_noparit`。
 */
export function scanInstantiations(text) {
  if (!text) return [];
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' "" ');
  const re = /(?:^|[;)}\s])([A-Za-z_$][\w$]*)\s*(?:#\s*\(|\s+[A-Za-z_$][\w$]*\s*\()/g;
  const found = new Set();
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[1];
    if (name.startsWith('$')) continue;
    if (VERILOG_KEYWORDS.has(name.toLowerCase())) continue;
    found.add(name);
  }
  return [...found];
}

/** 兼容旧接口：只返回与候选清单匹配的实例化名 */
export function findInstantiations(text, candidateNames) {
  const candidates = new Set(candidateNames || []);
  return scanInstantiations(text).filter((n) => candidates.has(n));
}

/** 检查 TB 文件头/体内是否有结束语句 */
export function hasSimulationEnd(text) {
  return /\$(?:finish|stop)\b/.test(text || '');
}

const SOURCE_SCAN_EXT = new Set(['.v', '.sv']);

/** 递归扫描目录下的 HDL 源文件（最多三层，跳过隐藏目录） */
async function scanHdlFiles(dir, { maxDepth = 2 } = {}) {
  const out = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length > 0) {
    const { dir: current, depth } = queue.shift();
    for (const entry of await listDirSafe(current)) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith('.')) queue.push({ dir: p, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && SOURCE_SCAN_EXT.has(path.extname(entry.name).toLowerCase())) out.push(p);
    }
  }
  return out;
}

function tbEntryFromFile({ filePath, moduleName, mods, moduleToFiles, ctx, activeTop, registered }) {
  const language = path.extname(filePath).toLowerCase() === '.sv' ? 'systemverilog' : 'verilog';
  const ownModules = new Set(mods || []);
  const text = sourceTextCache.get(filePath) || '';
  const instantiations = scanInstantiations(text);
  const knownDeps = [];
  const missingDeps = [];
  const primitives = [];
  for (const name of instantiations) {
    if (ownModules.has(name)) continue;
    if (moduleToFiles.has(name)) {
      knownDeps.push(name);
      continue;
    }
    if (isPrimitiveLike(name)) {
      primitives.push(name);
      continue;
    }
    missingDeps.push(name);
  }
  const isActive = !!(moduleName && activeTop && moduleName === activeTop);
  const warnings = [];
  if (!registered) warnings.push('该文件未注册到 sim_1 文件集（历史遗留文件），默认不会参与仿真');
  if (moduleName && !hasSimulationEnd(text)) warnings.push('没有找到 $finish/$stop，-runall 可能挂起，请确认 TB 会自行结束');
  if (language === 'vhdl') warnings.push('暂不支持 VHDL 测试平台自动编译');
  if (primitives.length) warnings.push(`实例化了 Xilinx 原语/库单元：${primitives.join(', ')}（可能需要 xelab -L unisims_ver）`);
  const missingText = missingDeps.length > 0 ? `缺少模块：${missingDeps.join(', ')}` : '';
  const simulatable = !!moduleName && registered && missingDeps.length === 0 && language !== 'vhdl';
  return {
    module: moduleName,
    file: filePath,
    relative: path.relative(ctx.projectDir, filePath),
    language,
    active: isActive,
    registered,
    dependencies: knownDeps,
    dependencyFiles: [
      ...new Set(
        knownDeps
          .map((d) => (moduleToFiles.get(d) || [])[0]?.path)
          .filter(Boolean),
      ),
    ].map((p) => path.relative(ctx.projectDir, p)),
    missingDependencies: missingDeps,
    libraryPrimitives: primitives,
    elaborateable: simulatable,
    simulatable,
    reason: simulatable
      ? '可以被 xvlog/xelab 直接仿真'
      : missingText || (!registered ? '未注册到 sim_1 文件集' : !moduleName ? '未找到 module 声明' : '暂不支持该语言'),
    warnings,
  };
}

// 当前扫描文件的原文缓存（module 提取与实例化扫描共用一次读取）
const sourceTextCache = new Map();

function pickTbModule(filePath, mods) {
  if (!mods || mods.length === 0) return null;
  const baseName = path.basename(filePath, path.extname(filePath));
  return (
    mods.find((m) => m.toLowerCase() === baseName.toLowerCase()) ||
    mods.find((m) => /(?:^|_)tb$/i.test(m) || /tb$/i.test(m)) ||
    mods[0] ||
    null
  );
}

/**
 * 列出 sim 文件集中的 testbench（含未注册到 xpr 的历史遗留文件），并判断依赖是否齐全。
 */
export async function listTestbenches({ projectDir, env = process.env, cwd = process.cwd() } = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd });
  const parsed = parseXpr(resolved.xprPath, createProjectContext(resolved.projectDir, resolved.xprPath));
  const ctx = parsed.context;
  const designSet = designFileSet(parsed);
  const simSet = simFileSet(parsed);
  const designSources = (designSet ? designSet.files : []).filter((f) => isHdlSource(f.path));
  const simSources = (simSet ? simSet.files : []).filter((f) => isSourceLike(f.path));

  // 模块 → 定义文件（只统计工程注册的设计源 + 仿真源）
  const moduleToFiles = new Map();
  const fileModules = new Map();
  const allFiles = [...designSources, ...simSources.filter((f) => isHdlSource(f.path))];
  for (const file of allFiles) {
    const text = (await readTextFileOrNull(file.path)) || '';
    sourceTextCache.set(file.path, text);
    const mods = extractModules(text);
    fileModules.set(file.path, mods);
    for (const mod of mods) {
      const list = moduleToFiles.get(mod) || [];
      list.push(file);
      moduleToFiles.set(mod, list);
    }
  }
  const activeTop = simTop(parsed);
  const registeredSimPaths = new Set(simSources.map((f) => path.resolve(f.path)));
  const simDirPath = path.dirname(
    simSources.length > 0
      ? simSources[0].path
      : path.join(ctx.srcsDir, simSet ? simSet.name : 'sim_1', 'new'),
  );
  const simRoot = path.resolve(ctx.srcsDir, simSet ? simSet.name : 'sim_1');
  const extraFiles = (await scanHdlFiles(simRoot)).filter((p) => !registeredSimPaths.has(path.resolve(p)));

  const testbenches = [];
  for (const file of simSources.filter((f) => isHdlSource(f.path))) {
    const mods = fileModules.get(file.path) || [];
    testbenches.push(
      tbEntryFromFile({
        filePath: file.path,
        moduleName: pickTbModule(file.path, mods),
        mods,
        moduleToFiles,
        ctx,
        activeTop,
        registered: true,
      }),
    );
  }
  for (const filePath of extraFiles) {
    const text = (await readTextFileOrNull(filePath)) || '';
    sourceTextCache.set(filePath, text);
    const mods = extractModules(text);
    testbenches.push(
      tbEntryFromFile({
        filePath,
        moduleName: pickTbModule(filePath, mods),
        mods: mods,
        moduleToFiles,
        ctx,
        activeTop,
        registered: false,
      }),
    );
  }

  testbenches.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.registered) - Number(a.registered) ||
      Number(b.simulatable) - Number(a.simulatable) ||
      a.relative.localeCompare(b.relative),
  );

  const usable = testbenches.filter((t) => t.simulatable);
  return {
    ok: true,
    projectDir: ctx.projectDir,
    simSet: parsed.activeSimSet,
    activeTop: activeTop || null,
    count: testbenches.length,
    registeredCount: testbenches.filter((t) => t.registered).length,
    usableCount: usable.length,
    testbenches,
    dataSource: 'xpr-parse（sim 文件集 + sim 目录，未启动 Vivado）',
  };
}

/** 根据名字（module 或文件名）解析 TB；未给名字时用工程当前 sim top */
export async function resolveTestbench({ projectDir, testbench, env, cwd } = {}) {
  const listed = await listTestbenches({ projectDir, env, cwd });
  let tb = null;
  if (testbench && String(testbench).trim()) {
    const needle = String(testbench).trim().toLowerCase();
    tb =
      listed.testbenches.find((t) => (t.module || '').toLowerCase() === needle) ||
      listed.testbenches.find((t) => path.basename(t.file, path.extname(t.file)).toLowerCase() === needle) ||
      listed.testbenches.find((t) => (t.module || '').toLowerCase().includes(needle)) ||
      null;
    if (!tb) {
      throw envError(
        `未找到测试平台：${testbench}`,
        `可用 testbench：${listed.testbenches
          .filter((t) => t.simulatable)
          .map((t) => t.module)
          .join(', ') || '（无）'}`,
      );
    }
  } else {
    tb = listed.testbenches.find((t) => t.active);
    if (!tb) {
      throw envError(
        `工程 sim set ${listed.simSet} 没有设置 TopModule，无法确定默认 testbench`,
        `显式传 testbench 参数。可用：${listed.testbenches
          .filter((t) => t.simulatable)
          .map((t) => t.module)
          .join(', ') || '（无）'}`,
      );
    }
  }
  if (!tb.simulatable) {
    throw envError(
      `测试平台 ${tb.module || path.basename(tb.file)} 不能直接仿真：${tb.reason || '依赖不完整'}`,
      `先补齐依赖源文件，或换一个可仿真的 testbench。可用：${listed.testbenches
        .filter((t) => t.simulatable)
        .map((t) => t.module)
        .join(', ')}`,
    );
  }
  return { ...tb, all: listed };
}

/** 把 run 状态整理成一行中文摘要（CLI/MCP 复用） */
export function summarizeRuns(runs) {
  return runs.map((r) => {
    const flags = [];
    if (r.current) flags.push('current');
    if (r.status === 'complete') flags.push('complete');
    if (r.progress != null) flags.push(`${r.progress}%`);
    return `${r.id}(${r.kind}${flags.length ? ', ' + flags.join(', ') : ''})`;
  });
}

/** 格式化耗时（避免上层重复实现） */
export { formatDurationMs };
export { findXprInDir };
