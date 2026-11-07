#!/usr/bin/env node
// Vivado toolchain offline regression tests (no real synthesis/implementation/bitstream required).
// Run: node test/run-tests.mjs
// 覆盖：
//   1) 解析器 fixture 单测（marker/进度/错误/时序/资源/功耗/仿真 + DRC 结构化）
//   2) MCP 协议 probe（spawn src/server.mjs：initialize/tools/list/tools/call/ping/错误码；14 个工具）
//   3) fake Vivado 异步 job 全链路（start/status/wait/output/cancel/list/并发保护/报告聚合/xpr 恢复/extra_xdc/DRC 负路径）
//   4) 调试工具（hw.mjs：hw_server 探测/按需启动、hw_scan/hw_program/debug_cores、bit SHA256、dcp 推导）
//   5) CLI（info/doctor/build/sim/reports/hw-scan/hw-program/debug-cores/退出码/--json）
//   6) 包与 bundle 文件完整性
//   7) 可选：真实 MCP SDK 客户端握手
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { McpProbeClient, ProbeError } from './probe-client.mjs';
import { evaluateBuildJob, startBuildJob } from '../src/core/build.mjs';
import { createProjectContext } from '../src/core/config.mjs';
import {
  evaluateHwJob,
  hwServerEnsure,
  parseHwMarkers,
  parseHwServerUrl,
  probeTcp,
  resolveDebugDcp,
  resolveHwServerBin,
  runDebugCores,
  runHwProgram,
  runHwScan,
  validateBitFile,
} from '../src/core/hw.mjs';
import { cancelJob, getJobOutput, getJobStatus, listJobs, waitJob } from '../src/core/jobs.mjs';
import {
  markersSatisfied,
  parseBusSkew,
  parseErrors,
  parseMarkers,
  parsePower,
  parseProgress,
  parseSimResult,
  parseTiming,
  parseUtilization,
  parseVivadoErrors,
  parseWarningsSummary,
  pickDrcErrors,
} from '../src/core/parse.mjs';
import { getProjectInfo, listTestbenches, parseXpr, scanInstantiations } from '../src/core/project.mjs';
import { collectReports } from '../src/core/reports.mjs';
import { evaluateSimJob, startSimJob } from '../src/core/sim.mjs';
import { isProcessAlive, sha256 } from '../src/core/util.mjs';
import { INSTRUCTIONS } from '../src/mcp/instructions.mjs';
import { renderDebugCores, renderHwProgram, renderHwScan } from '../src/mcp/tools.mjs';
import { parseXml, findChild, getAttr } from '../src/core/xml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');
const FAKE_BIN_DIR = path.join(FIXTURES, 'fake-vivado');
const FAKE_VIVADO = path.join(FAKE_BIN_DIR, 'vivado.bat');
const REAL_VIVADO = process.env.VIVADO_BIN || '';
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vivado-mcp-tests-'));

// ---------------------------------------------------------------------------
// 极简测试框架
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;
let skipCount = 0;
const failures = [];
const suiteStarted = Date.now();

function section(title) {
  process.stdout.write(`\n── ${title} ──\n`);
}
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    passCount++;
    process.stdout.write(`  ✓ ${name}（${Date.now() - started}ms）\n`);
  } catch (err) {
    failCount++;
    failures.push({ name, error: err });
    process.stdout.write(`  ✗ ${name}\n`);
    const stack = err && err.stack ? err.stack : String(err);
    process.stdout.write(
      stack
        .split(/\r?\n/)
        .slice(0, 6)
        .map((l) => `      ${l}`)
        .join('\n') + '\n',
    );
  }
}
function skip(name, reason) {
  skipCount++;
  process.stdout.write(`  - SKIP ${name}：${reason}\n`);
}
function check(cond, message) {
  if (!cond) throw new Error(message || '断言失败');
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function includes(haystack, needle, message) {
  const ok = typeof haystack === 'string' ? haystack.includes(needle) : Array.isArray(haystack) && haystack.includes(needle);
  if (!ok) throw new Error(`${message || '不包含'}：期望包含 ${JSON.stringify(needle)}`);
}
function near(actual, expected, tolerance, message) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || '数值不匹配'}：期望 ≈${expected}，实际 ${actual}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readFixtureLog(name) {
  return fs.readFileSync(path.join(FIXTURES, 'logs', name), 'utf8');
}

/** 新建一个 fake 工程副本 + fake tcl 目录 */
function newFakeProject(tag) {
  const dir = path.join(TMP_ROOT, `proj-${tag}`);
  fs.cpSync(path.join(FIXTURES, 'fake-project'), dir, { recursive: true });
  return dir;
}
function makeTempDir(tag) {
  const dir = path.join(TMP_ROOT, `tmp-${tag}-${Math.random().toString(16).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function newFakeTclDir(tag) {
  const dir = path.join(TMP_ROOT, `tcl-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['synth.tcl', 'bitgen.tcl', 'build.tcl', 'lib_flow.tcl', 'hw_scan.tcl', 'hw_program.tcl', 'debug_cores.tcl']) {
    fs.writeFileSync(path.join(dir, name), `# fake ${name} (offline test)\n`);
  }
  return dir;
}
function fakeEnv({ projectDir, tclDir, extra = {} }) {
  return {
    ...process.env,
    VIVADO_BIN: FAKE_VIVADO,
    VIVADO_PROJECT_ROOT: projectDir,
    VIVADO_MCP_TCL_DIR: tclDir,
    // 测试环境可能同时有真实 Vivado 在跑（T1 实测），避免被 GUI 进程检查误判为工程锁冲突
    VIVADO_MCP_ALLOW_EXTERNAL_VIVADO: '1',
    ...extra,
  };
}
/** 调试工具测试用环境：额外跳过 hw_server 探测/启动（不接触真实 3121 端口） */
function hwEnv({ projectDir, tclDir, extra = {} }) {
  return fakeEnv({ projectDir, tclDir, extra: { VIVADO_MCP_HW_SERVER_MODE: 'skip', ...extra } });
}
/** 新建带 current impl run + routed dcp 的 fake 工程（debug_cores 默认 dcp 推导用） */
function newFakeHwProject(tag) {
  const dir = path.join(TMP_ROOT, `hwproj-${tag}`);
  fs.mkdirSync(path.join(dir, 'FakeHw.srcs', 'sources_1', 'new'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'FakeHw.srcs', 'sources_1', 'new', 'fake_dut.v'), 'module fake_dut(input wire i_clk, output wire o); assign o = i_clk; endmodule\n');
  fs.mkdirSync(path.join(dir, 'FakeHw.runs', 'impl_1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'FakeHw.runs', 'impl_1', 'fake_dut_routed.dcp'), Buffer.from('fake routed dcp for tests'));
  fs.writeFileSync(
    path.join(dir, 'FakeHw.xpr'),
    `<?xml version="1.0" encoding="UTF-8"?>
<Project Version="7" Minor="39" Path="FakeHw.xpr">
  <Configuration>
    <Option Name="Part" Val="xc7a100tcsg324-1"/>
    <Option Name="ActiveSimSet" Val="sim_1"/>
    <Option Name="DefaultLib" Val="xil_defaultlib"/>
  </Configuration>
  <FileSets Version="1" Minor="31">
    <FileSet Name="sources_1" Type="DesignSrcs" RelSrcDir="$PSRCDIR/sources_1">
      <Filter Type="Srcs"/>
      <File Path="$PSRCDIR/sources_1/new/fake_dut.v"><FileInfo><Attr Name="UsedIn" Val="synthesis"/></FileInfo></File>
      <Config><Option Name="DesignMode" Val="RTL"/><Option Name="TopModule" Val="fake_dut"/></Config>
    </FileSet>
  </FileSets>
  <Runs Version="1" Minor="10">
    <Run Id="synth_1" Type="Ft3:Synth" SrcSet="sources_1" Part="xc7a100tcsg324-1" State="current" Dir="$PRUNDIR/synth_1">
      <Strategy Version="1" Minor="2"><StratHandle Name="Vivado Synthesis Defaults" Flow="Vivado Synthesis 2018"/><Step Id="synth_design"/></Strategy>
    </Run>
    <Run Id="impl_1" Type="Ft2:EntireDesign" Part="xc7a100tcsg324-1" ConstrsSet="" Description="fake impl" SynthRun="synth_1" State="current" Dir="$PRUNDIR/impl_1" GenFullBitstream="true">
      <Strategy Version="1" Minor="2"><StratHandle Name="Vivado Implementation Defaults" Flow="Vivado Implementation 2018"/><Step Id="init_design"/><Step Id="route_design"/><Step Id="write_bitstream"/></Strategy>
    </Run>
  </Runs>
  <Board/>
</Project>
`,
  );
  return dir;
}
/** 写一个假 bit 文件（用于 hw_program 校验/SHA256 测试） */
function writeFakeBit(dir, name = 'fake.bit', size = 256) {
  const bitPath = path.join(dir, name);
  fs.writeFileSync(bitPath, Buffer.alloc(size, 0x5b));
  return bitPath;
}
function sha256OfFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
/** 为后台 job 设置 fake 行为环境变量（runner 在 spawn 时快照 process.env；调用后立即还原） */
async function withProcEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
async function waitForJob({ projectDir, jobId, env, timeoutMs = 90000 }) {
  return await waitJob({ projectDir, jobId, timeoutMs, env, pollMs: 200 });
}
async function waitUntil(predicate, { timeoutMs = 20000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------------------------------------------------------------------
// 1. 解析器单测
// ---------------------------------------------------------------------------
async function testParsers() {
  section('1. 解析器 fixture 单测');
  const synthOk = readFixtureLog('synth-ok.log');
  const drcFail = readFixtureLog('bitstream-drc-fail.log');
  const simOk = readFixtureLog('sim-ok.log');
  const simFail = readFixtureLog('sim-fail.log');
  const timingText = readFixtureLog('timing_summary.rpt');
  const utilText = readFixtureLog('utilization.rpt');
  const powerText = readFixtureLog('power.rpt');

  await test('parseMarkers：SYNTH_DONE/IMPL_DONE/BITSTREAM_OK/REPORT/FINISH', () => {
    const m = parseMarkers(synthOk);
    check(m.synthDone, '应解析到 VMCP_SYNTH_DONE');
    eq(m.synthDone.progress, 100);
    includes(m.synthDone.status, 'Complete');
    eq(m.errors.length, 0);
    eq(m.lastFinish.ok, true);
    const f = parseMarkers(drcFail);
    check(f.implDone, '应解析到 VMCP_IMPL_DONE');
    eq(f.bitstreamOk, null);
    eq(f.lastFinish.ok, false);
    check(f.errors.length >= 1, '应解析到 VMCP_ERROR');
    eq(markersSatisfied(f, 'bitstream').ok, false);
    eq(markersSatisfied(f, 'impl').ok, true);
  });

  await test('parseProgress：marker/百分比/阶段', () => {
    const p = parseProgress(synthOk);
    eq(p.percent, 100);
    eq(p.source, 'marker');
    eq(p.stage, 'synth_done');
    const p2 = parseProgress('INFO: fake\nPROGRESS: 42%\nINFO: [Place 30-1] place_design');
    eq(p2.percent, 42);
    eq(p2.source, 'progress-line');
    eq(p2.stage, 'place_design');
    eq(parseProgress('nothing here').percent, null);
  });

  await test('parseErrors / parseWarningsSummary：区分 ERROR 与 CRITICAL WARNING', () => {
    const e = parseErrors(drcFail);
    eq(e.errors.length, 2);
    eq(e.criticalWarningCount, 0);
    eq(parseErrors('CRITICAL WARNING: [Constraints 18-5210] no constraints\nERROR: [Synth 8-1] bad').criticalWarningCount, 1);
    const w = parseWarningsSummary('20 Infos, 103 Warnings, 101 Critical Warnings and 0 Errors encountered.');
    eq(w.warnings, 103);
    eq(w.criticalWarnings, 101);
    eq(w.errors, 0);
  });

  await test('parseVivadoErrors + pickDrcErrors：DRC 错误码/阶段/Resolution', () => {
    const structured = parseVivadoErrors(drcFail);
    const drc = pickDrcErrors(structured);
    eq(drc.length, 2, '应有 2 条 DRC 错误');
    eq(drc[0].code, 'DRC NSTD-1');
    eq(drc[1].code, 'DRC UCIO-1');
    eq(drc[0].stage, 'write_bitstream');
    check(drc[0].resolve && drc[0].resolve.includes('IOSTANDARD'), '应解析 Resolution 行');
    includes(drc[1].message, 'Unconstrained Logical Port');
  });

  await test('parseSimResult：ok 路径 6 PASS', () => {
    const r = parseSimResult(simOk);
    eq(r.passCount, 6);
    eq(r.errorCount, 0);
    eq(r.ok, true);
    eq(r.finished, true);
    includes(r.passLabels, 'no-parity basic');
  });

  await test('parseSimResult：退出码 0 但全部 Error → ok=false，标签齐全', () => {
    const r = parseSimResult(simFail);
    eq(r.passCount, 0);
    eq(r.errorCount, 6);
    eq(r.errorLabels.length, 6);
    eq(r.ok, false);
    includes(r.errorLabels, 'even-parity mismatch');
  });

  await test('parseTiming（max，2018.3）：Design 2.907/30196 + Intra 空列 null + Inter From/To + Other Path Groups 独立', () => {
    const t = parseTiming(timingText);
    eq(t.hasReport, true);
    eq(t.reportKind, 'max');
    eq(t.timingScope, 'setup+pw');
    // Design Summary 真值（不得被 Other Path Groups/Intra 覆盖）
    near(t.designSummary.wns, 2.907, 1e-9);
    eq(t.designSummary.tns, 0);
    near(t.designSummary.tnsTotalEndpoints, 30196, 1e-9);
    eq(t.designSummary.wns, 2.907, 'designSummary.wns 不应被 Other Path Groups(13.285) 覆盖');
    eq(t.designSummary.whs, undefined, 'max 报告不应伪造 WHS');
    eq(t.otherPathGroups.length >= 1, true, 'Other Path Groups 应单独归类');
    eq(t.otherPathGroups[0].pathGroup, '**async_default**');
    near(t.otherPathGroups[0].wns, 13.285, 1e-9);
    // Intra：clk 的 WNS/TNS 是空列 → null（绝不能把 WPWS 当 WNS）
    const clkRow = t.intraClock.find((row) => row.clock === 'clk');
    check(clkRow, 'Intra 表应包含 clk');
    eq(clkRow.wns, null, 'clk 行 WNS 应为 null');
    eq(clkRow.tns, null, 'clk 行 TNS 应为 null');
    near(clkRow.wpws, 3, 1e-9);
    const fbRow = t.intraClock.find((row) => row.clock === 'clkfbout_mmcm');
    eq(fbRow.wns, null, 'clkfbout_mmcm WNS 应为 null（不是 8.408）');
    near(fbRow.wpws, 8.408, 1e-9);
    // 长时钟名 + Inter From/To 两列表头
    check(t.intraClock.some((row) => row.clock.includes('dbg_hub')), '应解析长时钟名行');
    eq(t.interClock.length > 0, true, 'Inter Clock Table 应解析出跨时钟路径');
    eq(t.interClock[0].fromClock, 'clk_out1_mmcm');
    eq(t.interClock[0].toClock, 'clk_out2_mmcm');
    near(t.interClock[1].wns, 2.907, 1e-9);
    eq(t.checks.hold.analyzed, false, 'max 报告 hold 未分析');
    eq(t.checks.setup.met, true);
    eq(t.checks.pulseWidth.met, true);
    eq(t.constraintsMet, true);
    includes(t.notes.join('\n'), '-delay_type max');
    // 旧键兼容别名（非枚举，不污染 JSON）
    near(t.designSummary['WNS(ns)'], 2.907, 1e-9);
    eq(t.designSummary['WHS(ns)'], undefined);
    eq(parseTiming('').hasReport, false);
  });

  await test('parseTiming（min_max）：WHS/THS 列 + timingScope=setup+hold+pw + hold 判定', () => {
    const t = parseTiming(readFixtureLog('timing_summary_min_max.rpt'));
    eq(t.hasReport, true);
    eq(t.reportKind, 'min_max');
    eq(t.timingScope, 'setup+hold+pw');
    near(t.designSummary.wns, 2.907, 1e-9);
    near(t.designSummary.whs, 0.312, 1e-9);
    eq(t.designSummary.ths, 0);
    eq(t.designSummary.thsFailingEndpoints, 0);
    eq(t.checks.hold.analyzed, true);
    eq(t.checks.hold.met, true);
    eq(t.checks.setup.met, true);
    eq(t.checks.pulseWidth.met, true);
    const clkRow = t.intraClock.find((row) => row.clock === 'clk');
    check(clkRow, 'min_max Intra 表应包含 clk');
    eq(clkRow.wns, null);
    eq(t.interClock.length, 2);
    eq(t.otherPathGroups.length, 2);
    includes(t.notes.join('\n'), 'min_max');
    // 空列保留 null，不把 WPWS 当 WHS
    const fbRow = t.intraClock.find((row) => row.clock === 'clkfbout_mmcm');
    eq(fbRow.whs, null);
    near(fbRow.wpws, 8.408, 1e-9);
  });

  await test('parseBusSkew：有约束取最小 slack/MET；空报告 applicable=false', () => {
    const clean = parseBusSkew(readFixtureLog('bus_skew_clean.rpt'));
    eq(clean.hasReport, true);
    eq(clean.applicable, true);
    eq(clean.constraints, 1);
    near(clean.worstSlackNs, 18.941, 1e-9);
    eq(clean.met, true);
    eq(clean.rows[0].requirementNs, 20);
    near(clean.rows[0].actualNs, 1.059, 1e-9);
    const empty = parseBusSkew(readFixtureLog('bus_skew_empty.rpt'));
    eq(empty.hasReport, true);
    eq(empty.applicable, false);
    eq(empty.worstSlackNs, null);
    eq(empty.met, null);
    includes(empty.notes.join('\n'), 'No bus skew constraints');
    eq(parseBusSkew('').hasReport, false);
  });

  await test('parseBusSkew（兜底）：无 Summary 表时从 Per Constraint 的 Slack 行提取', () => {
    const b = parseBusSkew(readFixtureLog('bus_skew_fallback.rpt'));
    eq(b.hasReport, true);
    eq(b.applicable, true);
    eq(b.constraints, 2);
    near(b.worstSlackNs, 18.941, 1e-9);
    eq(b.met, true);
    eq(b.rows.length, 2);
  });

  await test('parseTiming（无 | 边框的旧格式）：section 锚点仍可解析', () => {
    const t = parseTiming(readFixtureLog('timing_summary_legacy_max.rpt'));
    eq(t.hasReport, true);
    eq(t.reportKind, 'max');
    near(t.designSummary.wns, 2.907, 1e-9);
    eq(t.designSummary.tnsTotalEndpoints, 30196);
    const clkRow = t.intraClock.find((row) => row.clock === 'clk');
    eq(clkRow.wns, null);
    near(clkRow.wpws, 3, 1e-9);
    eq(t.interClock.length, 0, '无 Inter 表时应为空数组');
    eq(t.otherPathGroups.length, 0, '无 Other 表时应为空数组');
  });

  await test('parseUtilization：2018.3 四数值列表头 → LUT/FF/BRAM/DSP/IOB 含百分比', () => {
    const u = parseUtilization(utilText);
    eq(u.hasReport, true);
    eq(u.summary.lut.used, 29);
    eq(u.summary.lut.utilPercent, 0.02);
    eq(u.summary.lut.available, 133800);
    eq(u.summary.ff.used, 41);
    eq(u.summary.ff.utilPercent, 0.02);
    eq(u.summary.bram.used, 0);
    eq(u.summary.dsp.used, 0);
    eq(u.summary.iob.used, 16);
    eq(u.summary.iob.utilPercent, 4);
    // 不允许把 Available 错映射成 prohibited
    const lutRow = u.rows.find((r) => r.name === 'Slice LUTs');
    eq(lutRow.prohibited, null);
    eq(lutRow.available, 133800);
  });

  await test('parsePower：总功耗/动态/静态/置信度', () => {
    const p = parsePower(powerText);
    eq(p.hasReport, true);
    near(p.totalOnChipW, 0.139, 1e-9);
    near(p.dynamicW, 0, 1e-9);
    near(p.deviceStaticW, 0.138, 1e-9);
    eq(p.confidence, 'Medium');
  });

  await test('XML 解析 + 实例化启发式扫描（无假阳性/能发现缺失模块）', () => {
    const doc = parseXml(readFixtureLog('synth-ok.log') === '' ? '' : '<?xml version="1.0"?><a X="1"><b>t&amp;x</b><c/></a>');
    const a = findChild(doc, 'a');
    eq(getAttr(a, 'X'), '1');
    const tb = fs.readFileSync(path.join(FIXTURES, 'fake-project', 'Fake.srcs', 'sim_1', 'new', 'fake_tb.sv'), 'utf8');
    const inst = scanInstantiations(tb);
    includes(inst, 'fake_dut');
    check(!inst.includes('fake_dut_dut'), '不应出现截断的假类型名');
    eq(inst.length, 1);
  });

  await test('xpr 解析（fake 工程）：part/design top/sim top/current run', () => {
    const projDir = newFakeProject('xpr');
    const parsed = parseXpr(path.join(projDir, 'Fake.xpr'), createProjectContext(projDir, path.join(projDir, 'Fake.xpr')));
    eq(parsed.part, 'xc7a100tcsg324-1');
    eq(parsed.activeSimSet, 'sim_1');
    const design = parsed.fileSets.find((s) => s.type === 'DesignSrcs');
    eq(design.config.TopModule, 'fake_dut');
    const sim = parsed.fileSets.find((s) => s.type === 'SimulationSrcs');
    eq(sim.config.TopModule, 'fake_tb');
    const synth = parsed.runs.find((r) => r.kind === 'synth');
    const impl = parsed.runs.find((r) => r.kind === 'impl');
    eq(synth.current, true);
    eq(impl.synthRun, 'synth_1');
  });
}

// ---------------------------------------------------------------------------
// 2. MCP 协议 probe
// ---------------------------------------------------------------------------
async function testMcpProtocol() {
  section('2. MCP protocol (spawn src/server.mjs, newline-delimited JSON-RPC 2.0)');
  const projDir = newFakeProject('protocol');
  const client = await McpProbeClient.connect({
    args: [path.join(PACKAGE_ROOT, 'src', 'server.mjs')],
    cwd: projDir,
    env: {
      VIVADO_PROJECT_ROOT: projDir,
      VIVADO_BIN: FAKE_VIVADO,
      VIVADO_MCP_ALLOW_EXTERNAL_VIVADO: '1',
    },
  });
  try {
    let initResult = null;
    await test('initialize：协商版本/capabilities/serverInfo/中文 instructions', async () => {
      initResult = await client.initialize({ protocolVersion: '2025-11-25', clientInfo: { name: 'probe-test', version: '0.0.1' } });
      eq(initResult.protocolVersion, '2025-06-18');
      eq(initResult.capabilities.tools.listChanged, false);
      eq(initResult.serverInfo.name, 'vivado-mcp');
      check(initResult.serverInfo.version, 'serverInfo.version 应存在');
      check(typeof initResult.instructions === 'string' && initResult.instructions.length > 200, 'instructions 应为中文操作手册');
      check(Buffer.byteLength(initResult.instructions, 'utf8') <= 8192, 'instructions 必须 ≤8KB');
      includes(initResult.instructions, 'vivado_build_start');
      includes(initResult.instructions, 'vivado_hw_scan');
      includes(initResult.instructions, 'vivado_hw_program');
      includes(initResult.instructions, 'vivado_debug_cores');
      includes(initResult.instructions, 'JTAG 板卡');
    });

    await test('initialize：client 请求 2025-06-18 时原样协商', async () => {
      const r = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        clientInfo: { name: 'probe-test', version: '0.0.1' },
      });
      eq(r.protocolVersion, '2025-06-18');
    });

    await test('tools/list：14 个工具（11 构建/仿真 + 3 调试）且名称与契约一致', async () => {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      const expected = [
        'vivado_doctor',
        'vivado_project_info',
        'vivado_list_testbenches',
        'vivado_sim_start',
        'vivado_build_start',
        'vivado_job_status',
        'vivado_job_wait',
        'vivado_job_output',
        'vivado_job_cancel',
        'vivado_job_list',
        'vivado_reports',
        'vivado_hw_scan',
        'vivado_hw_program',
        'vivado_debug_cores',
      ].sort();
      eq(names.length, 14);
      eq(JSON.stringify(names), JSON.stringify(expected));
      for (const tool of tools) {
        check(tool.description && tool.description.length > 10, `${tool.name} 应有中文 description`);
        eq(tool.inputSchema.type, 'object');
      }
      const byName = new Map(tools.map((t) => [t.name, t]));
      eq(JSON.stringify(byName.get('vivado_hw_program').inputSchema.required), JSON.stringify(['bit_file']));
      check(byName.get('vivado_hw_scan').inputSchema.properties.hw_server_url, 'hw_scan 应有 hw_server_url 参数');
      check(byName.get('vivado_debug_cores').inputSchema.properties.dcp_file, 'debug_cores 应有 dcp_file 参数');
      check(byName.get('vivado_debug_cores').inputSchema.properties.include_nets, 'debug_cores 应有 include_nets 参数');
    });

    await test('ping 返回空对象', async () => {
      const p = await client.request('ping', {});
      check(p && typeof p === 'object');
    });

    await test('vivado_project_info：只读解析 fake 工程（器件/top/sim top/runs）', async () => {
      const result = await client.callTool('vivado_project_info', { project_dir: projDir });
      eq(result.isError, undefined);
      const info = result.structuredContent;
      check(info, '应返回 structuredContent');
      eq(info.part, 'xc7a100tcsg324-1');
      eq(info.design.top, 'fake_dut');
      eq(info.sim.top, 'fake_tb');
      eq(info.design.sourceCount, 1);
      check(info.runs.some((r) => r.id === 'synth_1' && r.current), '应包含 current synth run synth_1');
      check(info.runs.some((r) => r.id === 'impl_1' && r.current), '应包含 current impl run impl_1');
      includes(info.runs.find((r) => r.id === 'impl_1').synthRun || '', 'synth_1');
      includes(result.content[0].text, 'xc7a100tcsg324-1');
      check(typeof info.xpr.backupCount === 'number');
    });

    await test('vivado_list_testbenches：active TB 可仿真', async () => {
      const result = await client.callTool('vivado_list_testbenches', { project_dir: projDir });
      const data = result.structuredContent;
      eq(data.activeTop, 'fake_tb');
      const current = data.testbenches.find((t) => t.module === 'fake_tb');
      check(current && current.simulatable, 'fake_tb 应可仿真');
      eq(data.testbenches.length, 1);
    });

    await test('vivado_doctor（fake vivado）：结构化体检字段', async () => {
      const result = await client.callTool('vivado_doctor', { include_version: true });
      const report = result.structuredContent;
      eq(report.vivado.found, true);
      check(report.vivado.version && report.vivado.version.version === '2018.3', '应探测到 fake vivado 2018.3');
      eq(report.project.found, true);
      eq(report.project.dataSource.includes('xpr'), true);
      check(Array.isArray(report.knownNoise), 'knownNoise 应为数组');
    });

    await test('未知方法 → JSON-RPC -32601', async () => {
      try {
        await client.request('no/such/method', {});
        throw new Error('应当返回错误');
      } catch (err) {
        check(err instanceof ProbeError, '应是 ProbeError');
        eq(err.code, -32601);
      }
    });

    await test('tools/call 未知工具 → -32602', async () => {
      try {
        await client.callTool('vivado_not_a_tool', {});
        throw new Error('应当返回错误');
      } catch (err) {
        eq(err.code, -32602);
      }
    });

    await test('tools/call arguments 非对象 → -32602', async () => {
      try {
        await client.request('tools/call', { name: 'vivado_project_info', arguments: [1, 2, 3] });
        throw new Error('应当返回错误');
      } catch (err) {
        eq(err.code, -32602);
      }
    });

    await test('工具参数类型错误 → isError:true（不是协议错误）', async () => {
      const result = await client.callTool('vivado_project_info', { project_dir: 123 });
      eq(result.isError, true);
      includes(result.content[0].text, '失败');
      eq(result.structuredContent.ok, false);
      eq(result.structuredContent.error.code, 'INVALID_ARGUMENT');
    });

    await test('vivado_job_status 不存在的 job → isError:true + 修复建议', async () => {
      const result = await client.callTool('vivado_job_status', { job_id: 'nonexistent-job-xyz' });
      eq(result.isError, true);
      includes(result.content[0].text, '修复建议');
    });

    await test('vivado_job_list：空工程返回空列表', async () => {
      const projDir = newFakeProject('joblist');
      const result = await client.callTool('vivado_job_list', { project_dir: projDir });
      eq(result.structuredContent.ok, true);
      eq(result.structuredContent.count, 0);
    });

    await test('stdout 只包含协议帧（probe 客户端能解析所有行）', async () => {
      check(client.rawLines >= 6, `应至少收到 6 条协议消息，实际 ${client.rawLines}`);
    });
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// 3. fake Vivado 异步 job 全链路
// ---------------------------------------------------------------------------
async function testFakeJobs() {
  section('3. fake Vivado 异步 job 全链路（start/status/wait/output/cancel/并发/报告/xpr 恢复）');

  const projDir = newFakeProject('jobs');
  const tclDir = newFakeTclDir('jobs');
  const env = fakeEnv({ projectDir: projDir, tclDir });
  const xprPath = path.join(projDir, 'Fake.xpr');
  const xprBefore = sha256(fs.readFileSync(xprPath, 'utf8'));

  let synthJob = null;
  await test('build_start(synth) → done + ok + 100% + 报告目录约定 + VMCP_REPORT_DIR 注入', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'synth', env }),
    );
    synthJob = started;
    check(synthJob.job.id.includes('-synth-'), `job id 应包含 stage，实际 ${synthJob.job.id}`);
    const status = await waitForJob({ projectDir: projDir, jobId: synthJob.job.id, env });
    eq(status.status, 'done');
    eq(status.exitCode, 0);
    eq(status.progress.percent, 100);
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, true);
    check(evaluated.markers.synthDone, '应有 VMCP_SYNTH_DONE');
    eq(evaluated.failedStage, null);
    // job.json 契约：VMCP_REPORT_DIR 与 job.reportDir 一致（T3 报告的集成问题）
    const jobJson = JSON.parse(fs.readFileSync(path.join(synthJob.jobDir, 'job.json'), 'utf8'));
    eq(jobJson.env.VMCP_REPORT_DIR, jobJson.reportDir);
    eq(jobJson.env.VMCP_REPORT_DIR, path.join(projDir, '.vivado-mcp', 'reports', synthJob.job.id));
    eq(jobJson.meta.stageTcl, path.join(tclDir, 'synth.tcl'));
    check(jobJson.restoreXpr.backupPath.endsWith('Fake.xpr'), 'job.json 应记录 xpr 备份');
    check(fs.existsSync(jobJson.restoreXpr.backupPath), 'xpr 备份文件应存在');
  });

  await test('job_status 终态回写 job.json（含 markers）+ 进度/耗时/产物字段', async () => {
    const status = await getJobStatus({ projectDir: projDir, jobId: synthJob.job.id, env });
    const jobJson = JSON.parse(fs.readFileSync(path.join(synthJob.jobDir, 'job.json'), 'utf8'));
    eq(jobJson.status, 'done');
    eq(jobJson.exitCode, 0);
    check(jobJson.endedAt, 'job.json 应回写 endedAt');
    check(jobJson.markers && jobJson.markers.synthDone, 'job.json 应持久化 markers（审计/重启后判定需要）');
    check(jobJson.markers.lastFinish && jobJson.markers.lastFinish.ok === true, 'job.json markers 应含 VMCP_FINISH ok');
    check(status.elapsedMs > 0, 'elapsedMs 应 > 0');
    check(status.logFile.endsWith('run.log'));
    includes(status.logFile, synthJob.jobDir);
  });

  await test('job_output：返回日志尾部（lines 生效）', async () => {
    const output = await getJobOutput({ projectDir: projDir, jobId: synthJob.job.id, lines: 10, env });
    check(Array.isArray(output.lines) && output.lines.length > 0, '应返回日志行');
    check(output.lines.length <= 10, `lines=10 时不应超过 10 行，实际 ${output.lines.length}`);
    includes(output.lines.join('\n'), 'VMCP_SYNTH_DONE');
  });

  await test('job_list：包含已完成的 job', async () => {
    const list = await listJobs({ projectDir: projDir, limit: 10, env });
    check(list.jobs.some((j) => j.id === synthJob.job.id && j.status === 'done'), '列表应包含完成的 synth job');
  });

  await test('xpr 恢复：fake Vivado 改写 xpr 后 job 结束恢复为备份内容', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_MUTATE_XPR: '1', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'synth', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    check(status.xprRestored && status.xprRestored.restoredAt, '应记录 xpr 已恢复');
    eq(sha256(fs.readFileSync(xprPath, 'utf8')), xprBefore, 'xpr 内容应恢复为运行前内容');
  });

  await test('build_start(bitstream) + extra_xdc → ok + bit + 报告可解析', async () => {
    const extraXdc = path.join(projDir, 'extra_smoke.xdc');
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'bitstream', extraXdc, env }),
    );
    eq(started.extraXdc, extraXdc);
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    eq(status.meta.extraXdc, extraXdc);
    const jobJson = JSON.parse(fs.readFileSync(path.join(started.jobDir, 'job.json'), 'utf8'));
    eq(jobJson.env.VMCP_EXTRA_XDC, extraXdc, 'VMCP_EXTRA_XDC 应注入 job env');
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, true);
    check(evaluated.bitstream && evaluated.bitstream.exists, 'bit 文件应存在');
    eq(evaluated.bitstream.size, 1024);
    // 报告聚合：必须从 job.reportDir（= VMCP_REPORT_DIR）解析到三类报告
    const reports = await collectReports({ projectDir: projDir, jobId: started.job.id, env });
    eq(reports.source, 'job');
    eq(reports.timing.hasReport, true);
    eq(reports.utilization.hasReport, true);
    eq(reports.power.hasReport, true);
    near(reports.timing.designSummary.wns, 2.907, 1e-9);
    eq(reports.timing.designSummary.tnsTotalEndpoints, 30196);
    eq(reports.timing.reportKind, 'max');
    eq(reports.timing.timingScope, 'setup+pw');
    check(reports.timing.reportFile && fs.existsSync(reports.timing.reportFile), 'timing.reportFile 应存在');
    eq(reports.timing.otherPathGroups.length >= 1, true, 'Other Path Groups 不应覆盖 Design Summary');
    // Round 4：bus skew 分类 + verdict
    check(reports.timing.busSkew, 'fake job 应带 bus skew 报告');
    eq(reports.timing.busSkew.applicable, true);
    eq(reports.timing.busSkew.constraints, 1);
    near(reports.timing.busSkew.worstSlackNs, 18.941, 1e-9);
    eq(reports.verdict.setupMet, true);
    eq(reports.verdict.holdAnalyzed, false);
    eq(reports.verdict.timingScope, 'setup+pw');
    eq(reports.verdict.busSkewAnalyzed, true);
    eq(reports.verdict.busSkewMet, true);
    eq(reports.verdict.timingMet, true);
    check(reports.files.some((f) => f.kind === 'bus_skew'), '报告列表应分类出 bus_skew');
    check(reports.files.every((f) => typeof f.mtime === 'string' && typeof f.stale === 'boolean'), '报告应带 mtime/stale 字段');
    eq(reports.utilization.summary.lut.used, 29);
    eq(reports.utilization.summary.lut.utilPercent, 0.02);
    eq(reports.utilization.summary.iob.utilPercent, 4);
    near(reports.power.totalOnChipW, 0.139, 1e-9);
    check(reports.bitstream && reports.bitstream.exists, 'reports 应包含 bit 文件信息');
    eq(reports.job.ok, true);
    // 文本渲染不得出现 undefined / '?%'，并包含百分比
    const { renderReports } = await import('../src/mcp/tools.mjs');
    const reportText = renderReports(reports);
    check(!/undefined/.test(reportText), `报告文本不应出现 undefined：\n${reportText}`);
    check(!/\(\?%\)/.test(reportText), `报告文本不应出现 ?%：\n${reportText}`);
    includes(reportText, 'LUT=29 (0.02%)');
    includes(reportText, 'WNS=2.907ns');
    includes(reportText, '时序判定（setup+pulseWidth（不含 hold））');
    includes(reportText, 'bus skew 判定：满足');
    check(!/WHS=/.test(reportText), 'max 报告不应渲染 WHS');
    // 旧“约束满足”行必须标注范围（不能暗示含 hold）
    includes(reportText, '范围=setup+pulseWidth（不含 hold）');
    // 报告文件里应优先使用 impl 报告（如同时存在 synth/impl）
    includes(reports.files.map((f) => f.name).join(','), 'timing');
  });

  await test('min_max 报告（fake）：WHS/THS 解析 + verdict hold 判定 + 报告文本 WHS 行', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined, FAKE_TIMING_REPORT: 'timing_summary_min_max.rpt' }, () =>
      startBuildJob({ projectDir: projDir, stage: 'bitstream', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    const reports = await collectReports({ projectDir: projDir, jobId: started.job.id, env });
    eq(reports.timing.reportKind, 'min_max');
    eq(reports.timing.timingScope, 'setup+hold+pw');
    near(reports.timing.designSummary.whs, 0.312, 1e-9);
    eq(reports.timing.checks.hold.analyzed, true);
    eq(reports.verdict.holdAnalyzed, true);
    eq(reports.verdict.holdMet, true);
    eq(reports.verdict.timingMet, true);
    eq(reports.verdict.timingScope, 'setup+hold+pw');
    eq(reports.timing.otherPathGroups.length >= 1, true);
    const { renderReports } = await import('../src/mcp/tools.mjs');
    const text = renderReports(reports);
    includes(text, 'WHS=0.312ns');
    includes(text, 'THS=0ns');
    includes(text, 'hold：满足');
    includes(text, '时序判定（setup+hold+pulseWidth）：满足');
    check(!/undefined/.test(text), `min_max 报告文本不应出现 undefined：\n${text}`);
  });

  await test('bus skew 空报告（fake，真实行为：No bus skew constraints）：applicable=false + verdict 不判定', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined, FAKE_BUS_SKEW: 'empty' }, () =>
      startBuildJob({ projectDir: projDir, stage: 'impl', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    const reports = await collectReports({ projectDir: projDir, jobId: started.job.id, env });
    check(reports.timing.busSkew, '应有 bus skew 报告对象');
    eq(reports.timing.busSkew.hasReport, true);
    eq(reports.timing.busSkew.applicable, false);
    eq(reports.timing.busSkew.constraints, 0);
    eq(reports.timing.busSkew.worstSlackNs, null);
    eq(reports.timing.busSkew.met, null);
    eq(reports.verdict.busSkewAnalyzed, false);
    eq(reports.verdict.busSkewMet, null);
    includes(reports.timing.busSkew.notes.join('\n'), 'No bus skew constraints');
    const { renderReports } = await import('../src/mcp/tools.mjs');
    includes(renderReports(reports), '报告存在但无约束');
  });

  await test('历史回放 ERROR（stale replay）不误判：权威成功时降级为提示，ok=true', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'stale-error', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'bitstream', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, true, '历史回放的旧 DRC ERROR 不应把成功构建误判为失败');
    eq(evaluated.failures.length, 0);
    eq(evaluated.errors.length, 0, '当前 flow（VMCP 标记之后）应无 ERROR');
    eq(evaluated.staleLogErrorCount >= 2, true, '应识别出历史回放 ERROR');
    eq(evaluated.drcErrors.length, 0, '历史 DRC 不应进入当前 drcErrors');
    eq(evaluated.structuredErrors.length, 0);
    check(evaluated.notes.some((n) => n.level === 'stale-log'), '应有 stale-log 提示');
    const { renderJob } = await import('../src/mcp/tools.mjs');
    const text = renderJob(evaluated);
    includes(text, '历史回放');
    check(!/undefined/.test(text), `renderJob 不应出现 undefined：\n${text}`);
  });

  await test('当前 flow 的 ERROR（VMCP 标记之后）仍判失败：ok=false + NO_LOG_ERROR', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'stale-error-active', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'bitstream', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, false, '当前 flow 的真实 ERROR 必须使 ok=false（不被降级逻辑吞掉）');
    includes(evaluated.failures.map((f) => f.code), 'NO_LOG_ERROR');
    eq(evaluated.errors.length, 1);
    eq(evaluated.staleLogErrorCount >= 2, true);
  });

  await test('DRC 负路径（stage=bitstream）：ok=false + DRC 错误码/失败阶段/write_bitstream', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'drc', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'bitstream', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'failed');
    eq(status.exitCode, 1);
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, false);
    eq(evaluated.failedStage, 'write_bitstream');
    const codes = evaluated.failures.map((f) => f.code);
    includes(codes, 'DRC_NSTD-1', 'failures 应包含 DRC NSTD-1 错误码');
    includes(codes, 'DRC_UCIO-1', 'failures 应包含 DRC UCIO-1 错误码');
    eq(evaluated.drcErrors.length, 2);
    check(evaluated.drcErrors[0].resolve, 'DRC 错误应带 Resolution 建议');
    eq(evaluated.bitstream, null);
    includes(evaluated.summary, 'write_bitstream');
  });

  await test('synth 失败负路径：ok=false + VMCP_ERROR/ERROR 归因', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'fail', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'synth', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'failed');
    const evaluated = await evaluateBuildJob(status);
    eq(evaluated.ok, false);
    check(evaluated.failures.length > 0, '应有结构化失败原因');
    includes(evaluated.failures.map((f) => f.message).join('\n'), 'Fake synthesis failure');
  });

  await test('并发保护：同工程同时只允许一个构建 job', async () => {
    const first = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: '15000' }, () =>
      startBuildJob({ projectDir: projDir, stage: 'full', env }),
    );
    try {
      await waitUntil(async () => {
        const s = await getJobStatus({ projectDir: projDir, jobId: first.job.id, env });
        return s.status === 'running' && !!s.runnerPid;
      }, { label: '第一个 job 进入 running' });
      let conflict = null;
      try {
        await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
          startBuildJob({ projectDir: projDir, stage: 'synth', env }),
        );
      } catch (err) {
        conflict = err;
      }
      check(conflict, '第二个构建 job 应被拒绝');
      eq(conflict.code, 'CONFLICT');
      includes(conflict.message, first.job.id);
    } finally {
      const cancelled = await cancelJob({ projectDir: projDir, jobId: first.job.id, env });
      eq(cancelled.status.status, 'cancelled');
    }
  });

  await test('job_cancel：杀进程树 + 状态落盘 cancelled', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: '30000' }, () =>
      startBuildJob({ projectDir: projDir, stage: 'full', env }),
    );
    const running = await waitUntil(async () => {
      const s = await getJobStatus({ projectDir: projDir, jobId: started.job.id, env });
      return s.status === 'running' && s.runnerPid ? s : null;
    }, { label: 'job 进入 running' });
    check(running.pid, '应有子进程 pid');
    // 运行中状态不能显示“100%/失败”这类误导信息
    check(running.progress.percent === null || running.progress.percent < 100, `运行中进度不应为 100%（实际 ${running.progress.percent}）`);
    eq(running.failures.length, 0, '运行中不应有失败原因');
    const result = await cancelJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(result.alreadyTerminal, false);
    eq(result.cancelled, true);
    eq(result.status.status, 'cancelled');
    check(!isProcessAlive(running.runnerPid), `runner 进程 ${running.runnerPid} 应已终止`);
    const jobJson = JSON.parse(fs.readFileSync(path.join(started.jobDir, 'job.json'), 'utf8'));
    eq(jobJson.status, 'cancelled');
  });

  await test('仿真 ok 路径：xvlog→xelab→xsim，6 PASS', async () => {
    const started = await withProcEnv({ FAKE_XSIM_MODE: 'ok', FAKE_XELAB_MODE: undefined, FAKE_XVLOG_MODE: undefined }, () =>
      startSimJob({ projectDir: projDir, env }),
    );
    eq(started.testbench.module, 'fake_tb');
    includes(started.commands.xvlog.args, '-sv');
    includes(started.commands.xvlog.args, '-work');
    includes(started.commands.xvlog.args, '-work', 'xvlog 应使用 -work');
    includes(started.commands.xelab.args, 'work.fake_tb');
    check(started.workDir.endsWith('simwork'), '仿真工作目录应隔离在 <job>/simwork');
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    eq(status.exitCode, 0);
    const evaluated = await evaluateSimJob(status);
    eq(evaluated.ok, true);
    eq(evaluated.sim.passCount, 6);
    eq(evaluated.sim.errorCount, 0);
    check(fs.existsSync(path.join(started.workDir, 'xsim.dir')), 'xsim.dir 应生成在工作目录');
    includes(evaluated.summary, '仿真通过');
  });

  await test('仿真负路径（退出码 0 但有 6 个 Error）：ok=false + 用例 label', async () => {
    const started = await withProcEnv({ FAKE_XSIM_MODE: 'fail' }, () => startSimJob({ projectDir: projDir, env }));
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
    eq(status.exitCode, 0);
    const evaluated = await evaluateSimJob(status);
    eq(evaluated.ok, false, 'xsim 退出码 0 不能判定成功');
    eq(evaluated.sim.errorCount, 6);
    eq(evaluated.sim.passCount, 0);
    eq(evaluated.sim.errorLabels.length, 6);
    includes(evaluated.failures.map((f) => f.code), 'SIM_ERRORS');
    includes(evaluated.failures.map((f) => f.code), 'SIM_NO_PASS');
    includes(evaluated.failures.map((f) => f.message).join('\n'), 'timeout waiting for o_dv assertion');
  });

  await test('仿真失败负路径（xelab 报错）→ ok=false + 错误摘要', async () => {
    const started = await withProcEnv({ FAKE_XSIM_MODE: 'ok', FAKE_XELAB_MODE: 'fail' }, () => startSimJob({ projectDir: projDir, env }));
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'failed');
    const evaluated = await evaluateSimJob(status);
    eq(evaluated.ok, false);
    includes(evaluated.failures.map((f) => f.message).join('\n'), 'elaboration error');
  });

  await test('单 build job 结束后可再次启动（锁已释放）', async () => {
    const started = await withProcEnv({ FAKE_VIVADO_MODE: 'ok', FAKE_VIVADO_SLEEP_MS: undefined }, () =>
      startBuildJob({ projectDir: projDir, stage: 'synth', env }),
    );
    const status = await waitForJob({ projectDir: projDir, jobId: started.job.id, env });
    eq(status.status, 'done');
  });

  await test('job_list：扫描全部 job、按开始时间倒序、容错非本工具目录、limit 生效', async () => {
    // 模拟 T1 手工证据目录（无 job.json）：必须容错跳过而不是列表变空/崩溃
    const foreign = path.join(projDir, '.vivado-mcp', 'jobs', 't1-manual-artifact');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'README.txt'), 'foreign directory without job.json');
    const list = await listJobs({ projectDir: projDir, limit: 50, env });
    check(list.count >= 8, `应扫描到本工具创建的全部 job，实际 ${list.count}`);
    check(!list.jobs.some((j) => j.id === 't1-manual-artifact'), '非本工具格式目录应被容错跳过');
    for (let i = 1; i < list.jobs.length; i++) {
      check(
        (list.jobs[i - 1].startedAtMs || 0) >= (list.jobs[i].startedAtMs || 0),
        `job 应按开始时间倒序：${list.jobs[i - 1].id} < ${list.jobs[i].id}`,
      );
    }
    const limited = await listJobs({ projectDir: projDir, limit: 2, env });
    eq(limited.returned, 2);
    eq(limited.truncated, true);
    includes(limited.note, 'limit=2');
    eq(limited.jobs.length, 2);
  });

  await test('reports（不传 job_id）：优先报告完整的本工具链 job 目录，忽略外部报告目录', async () => {
    // 造一个更新、但只有部分报告的外部目录（如 T1 手工报告）
    const foreignReportDir = path.join(projDir, '.vivado-mcp', 'reports', 'manual-external');
    fs.mkdirSync(foreignReportDir, { recursive: true });
    fs.writeFileSync(path.join(foreignReportDir, 'stale_note.txt'), 'not a real report');
    const report = await collectReports({ projectDir: projDir, env });
    eq(report.source, 'latest-report-dir');
    check(report.reportDir, '应选中一个报告目录');
    check(/[\\/]\d{8}T\d{6}Z-/.test(report.reportDir), `应优先本工具链 job 报告目录，实际 ${report.reportDir}`);
    eq(report.timing.hasReport, true);
    eq(report.utilization.hasReport, true);
    eq(report.utilization.summary.lut.utilPercent, 0.02);
  });
}

// ---------------------------------------------------------------------------
// 4. 调试工具（Round 3：hw.mjs / hw_scan / hw_program / debug_cores）
// ---------------------------------------------------------------------------
async function testHwTools() {
  section('4. 调试工具（hw.mjs：hw_server/hw_scan/hw_program/debug_cores，BIT SHA256，14 工具）');

  await test('parseHwServerUrl / probeTcp / hwServerEnsure（TCP 正负路径、skip 模式、非本地报错）', async () => {
    const parsed = parseHwServerUrl('tcp://127.0.0.1:3122');
    eq(parsed.host, '127.0.0.1');
    eq(parsed.port, 3122);
    eq(parsed.isLocal, true);
    eq(parseHwServerUrl('').url, 'localhost:3121');
    eq(parseHwServerUrl('remote-host:3121').isLocal, false);
    eq(parseHwServerUrl('[::1]:3121').host, '::1');

    // 本地临时 TCP server 模拟 hw_server（不接触真实 3121）
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      eq(await probeTcp('127.0.0.1', port, { timeoutMs: 1000 }), true, '本地监听时应可连接');
      const ensured = await hwServerEnsure({ url: `127.0.0.1:${port}`, env: {}, probeTimeoutMs: 1000 });
      eq(ensured.connected, true);
      eq(ensured.launchedByTool, false, '已有 server 不应重复启动');
      eq(ensured.port, port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    eq(await probeTcp('127.0.0.1', port, { timeoutMs: 300 }), false, '关闭后应不可连接');

    const skipped = await hwServerEnsure({ env: { VIVADO_MCP_HW_SERVER_MODE: 'skip' } });
    eq(skipped.skipped, true);
    eq(skipped.connected, false);
    eq(skipped.launchedByTool, false);

    let error = null;
    try {
      await hwServerEnsure({ url: '192.0.2.1:3121', env: {}, probeTimeoutMs: 300 });
    } catch (err) {
      error = err;
    }
    check(error, '非本地不可达地址应抛错');
    eq(error.code, 'HW_SERVER_UNAVAILABLE');
    includes(error.message, '非本地');

    if (fs.existsSync(REAL_VIVADO)) {
      const hwServerBin = await resolveHwServerBin({ env: {}, vivadoBin: REAL_VIVADO });
      check(hwServerBin && hwServerBin.toLowerCase().endsWith('hw_server.bat'), `应从 Vivado bin 目录找到 hw_server.bat，实际 ${hwServerBin}`);
    } else {
      skip('resolveHwServerBin 真实路径', '本机未安装 Vivado');
    }
  });

  await test('parseHwMarkers：HW_DONE/PROGRAM_DONE/DEBUG_DONE/RESULT_JSON/FINISH/ERROR', () => {
    const scan = parseHwMarkers('VMCP_HW_DONE targets=1 devices=0\nVMCP_RESULT_JSON C:\\x\\r.json\nVMCP_FINISH ok\n');
    eq(scan.scanDone.targets, 1);
    eq(scan.scanDone.devices, 0);
    eq(scan.resultJson, 'C:\\x\\r.json');
    eq(scan.lastFinish.ok, true);
    const program = parseHwMarkers('VMCP_PROGRAM_DONE programmed=1\nVMCP_FINISH ok');
    eq(program.programDone.programmed, true);
    const debug = parseHwMarkers('VMCP_DEBUG_DONE cores=3\nVMCP_ERROR boom\nVMCP_FINISH fail');
    eq(debug.debugDone.cores, 3);
    eq(debug.lastFinish.ok, false);
    includes(debug.errors, 'boom');
  });

  await test('validateBitFile：绝对路径/存在性/.bit 后缀 + SHA256', async () => {
    const dir = makeTempDir('bit');
    const bit = writeFakeBit(dir, 'u.bit', 256);
    const info = await validateBitFile(bit);
    eq(info.path, bit);
    eq(info.size, 256);
    eq(info.sha256, sha256OfFile(bit));

    const cases = [
      ['relative.bit', '绝对路径'],
      [path.join(dir, 'missing.bit'), '不存在'],
      [writeFakeBit(dir, 'x.txt', 8), '.bit 文件'],
    ];
    for (const [input, expected] of cases) {
      let error = null;
      try {
        await validateBitFile(input);
      } catch (err) {
        error = err;
      }
      check(error, `${input} 应被拒绝`);
      includes(error.message, expected, `${input} 错误信息应包含 ${expected}`);
    }
    let emptyError = null;
    try {
      await validateBitFile('');
    } catch (err) {
      emptyError = err;
    }
    check(emptyError, '空 bit_file 应被拒绝');
    includes(emptyError.message, '缺少必填参数 bit_file');
  });

  await test('runHwScan（fake，无板卡）：ok=true + devices=[] + job kind=hw + status/list 可查', async () => {
    const projDir = newFakeHwProject('scan');
    const tclDir = newFakeTclDir('hw-scan');
    const env = hwEnv({ projectDir: projDir, tclDir });
    const result = await withProcEnv({ FAKE_HW_MODE: 'ok' }, () => runHwScan({ projectDir: projDir, env }));
    eq(result.ok, true);
    eq(result.targets.length, 1);
    eq(result.devices.length, 0, '无板卡时 devices 应为空');
    eq(result.ilas.length, 0);
    eq(result.hwServer.skipped, true);
    check(result.jobId.includes('-hw-scan-'), `jobId 应包含 stage：${result.jobId}`);
    eq(result.stage, 'hw-scan');
    check(fs.existsSync(result.jsonPath), `结果 JSON 应存在：${result.jsonPath}`);
    eq(result.json.ok, true);
    includes(result.logFile, 'run.log');
    const status = await getJobStatus({ projectDir: projDir, jobId: result.jobId, env });
    eq(status.kind, 'hw');
    eq(status.status, 'done');
    const evaluated = await evaluateHwJob(status);
    eq(evaluated.ok, true);
    const list = await listJobs({ projectDir: projDir, limit: 10, env });
    includes(list.jobs.map((job) => job.id), result.jobId);
    // hw job 也能被 reports 查询（不产生构建报告，但应返回硬件 job 摘要而不是报错）
    const report = await collectReports({ projectDir: projDir, jobId: result.jobId, env });
    eq(report.ok, true);
    eq(report.job.kind, 'hw');
    eq(report.job.status, 'done');
    includes(report.notes.join('\n'), '硬件调试任务');
    const text = renderHwScan(result);
    check(!/undefined/.test(text), `渲染文本不应出现 undefined：\n${text}`);
    includes(text, 'devices：0 个');
  });

  await test('runHwScan（fake fail）：ok=false + HW_CONNECT_FAILED/VMCP_ERROR 结构化', async () => {
    const projDir = newFakeHwProject('scan-fail');
    const tclDir = newFakeTclDir('hw-scan-fail');
    const env = hwEnv({ projectDir: projDir, tclDir });
    const result = await withProcEnv({ FAKE_HW_MODE: 'fail' }, () => runHwScan({ projectDir: projDir, env }));
    eq(result.ok, false);
    eq(result.status, 'failed');
    includes(result.failures.map((f) => f.code).join(','), 'HW_CONNECT_FAILED');
    check(result.failures.some((f) => f.code === 'VMCP_ERROR' || f.code === 'JOB_FAILED'), '失败原因应包含 VMCP/JOB 错误');
    const text = renderHwScan(result);
    includes(text, 'ok=false');
  });

  await test('runHwProgram（fake ok）：programmed=true + SHA256 + verify + job 元数据', async () => {
    const projDir = newFakeHwProject('program');
    const tclDir = newFakeTclDir('hw-program');
    const env = hwEnv({ projectDir: projDir, tclDir });
    const bit = writeFakeBit(projDir, 'fake_prog.bit', 512);
    const result = await withProcEnv({ FAKE_HW_MODE: 'ok' }, () => runHwProgram({ bitFile: bit, projectDir: projDir, verify: true, env }));
    eq(result.ok, true);
    eq(result.programmed, true);
    eq(result.bitFile, bit);
    eq(result.bitSha256, sha256OfFile(bit));
    eq(result.bitSize, 512);
    eq(result.verify.requested, true);
    eq(result.verify.passed, true);
    check(result.device && result.device.part === 'xc7a200t', '应返回目标设备信息');
    eq(result.json.bitFile, bit, 'VMCP_BIT_FILE 应传入 TCL 并反映在 JSON');
    check(result.jobId.includes('-hw-program-'));
    const status = await getJobStatus({ projectDir: projDir, jobId: result.jobId, env });
    eq(status.kind, 'hw');
    const text = renderHwProgram(result);
    check(!/undefined/.test(text), `渲染文本不应出现 undefined：\n${text}`);
    includes(text, result.bitSha256);
  });

  await test('runHwProgram（fake 无设备）：ok=false + NO_HW_DEVICE 结构化失败', async () => {
    const projDir = newFakeHwProject('program-nodev');
    const tclDir = newFakeTclDir('hw-program-nodev');
    const env = hwEnv({ projectDir: projDir, tclDir });
    const bit = writeFakeBit(projDir, 'nodev.bit', 128);
    const result = await withProcEnv({ FAKE_HW_MODE: 'no-device' }, () => runHwProgram({ bitFile: bit, projectDir: projDir, env }));
    eq(result.ok, false);
    eq(result.programmed, false);
    eq(result.status, 'failed');
    eq(result.exitCode, 1);
    includes(result.failures.map((f) => f.code).join(','), 'NO_HW_DEVICE');
    includes(renderHwProgram(result), 'NO_HW_DEVICE');
  });

  await test('runHwProgram：hw_server 不可达时 isError 语义（HW_SERVER_UNAVAILABLE，不创建 job）', async () => {
    const projDir = newFakeHwProject('program-noserver');
    const tclDir = newFakeTclDir('hw-program-noserver');
    const env = hwEnv({ projectDir: projDir, tclDir, extra: { VIVADO_MCP_HW_SERVER_MODE: undefined } });
    const bit = writeFakeBit(projDir, 'noserver.bit', 64);
    let error = null;
    try {
      await runHwProgram({ bitFile: bit, projectDir: projDir, hwServerUrl: '192.0.2.1:3121', env });
    } catch (err) {
      error = err;
    }
    check(error, 'hw_server 不可达应抛错');
    eq(error.code, 'HW_SERVER_UNAVAILABLE');
  });

  await test('runDebugCores（fake）：默认推导 routed.dcp + cores/ports + include_nets', async () => {
    const projDir = newFakeHwProject('debug');
    const tclDir = newFakeTclDir('debug-cores');
    const env = hwEnv({ projectDir: projDir, tclDir });
    const result = await withProcEnv({ FAKE_HW_MODE: 'ok' }, () => runDebugCores({ projectDir: projDir, env }));
    eq(result.ok, true);
    eq(result.dcpSource, 'derived');
    includes(result.dcp, 'fake_dut_routed.dcp');
    eq(result.implRun, 'impl_1');
    eq(result.top, 'fake_dut');
    eq(result.cores.length, 2);
    eq(result.cores[0].name, 'u_ila_0');
    eq(result.cores[0].type, 'ila');
    eq(result.includeNets, false);
    check(!('net' in result.cores[0].ports[0]), 'include_nets=false 时不应包含 net');
    check(!/undefined/.test(renderDebugCores(result)), '渲染文本不应出现 undefined');

    const withNets = await withProcEnv({ FAKE_HW_MODE: 'ok' }, () => runDebugCores({ projectDir: projDir, includeNets: true, env }));
    eq(withNets.ok, true);
    eq(withNets.includeNets, true);
    eq(withNets.cores[0].ports[0].net, 'clk_25m');
    includes(renderDebugCores(withNets), 'net=clk_25m');

    const explicit = await withProcEnv({ FAKE_HW_MODE: 'ok' }, () => runDebugCores({ projectDir: projDir, dcpFile: result.dcp, env }));
    eq(explicit.ok, true);
    eq(explicit.dcpSource, 'explicit');
  });

  await test('runDebugCores：dcp 缺失 → DCP_NOT_FOUND；相对路径 → 参数错误', async () => {
    const projDir = newFakeHwProject('debug-missing');
    const tclDir = newFakeTclDir('debug-missing');
    const env = hwEnv({ projectDir: projDir, tclDir });
    fs.rmSync(path.join(projDir, 'FakeHw.runs', 'impl_1', 'fake_dut_routed.dcp'), { force: true });
    let missingError = null;
    try {
      await runDebugCores({ projectDir: projDir, env });
    } catch (err) {
      missingError = err;
    }
    check(missingError, '缺 dcp 应抛错');
    eq(missingError.code, 'DCP_NOT_FOUND');

    let relativeError = null;
    try {
      await runDebugCores({ projectDir: projDir, dcpFile: 'relative.dcp', env });
    } catch (err) {
      relativeError = err;
    }
    check(relativeError, '相对 dcp 路径应被拒绝');
    includes(relativeError.message, '绝对路径');

    let explicitMissing = null;
    try {
      await resolveDebugDcp({ ctx: createProjectContext(projDir, path.join(projDir, 'FakeHw.xpr')), dcpFile: path.join(projDir, 'nope.dcp') });
    } catch (err) {
      explicitMissing = err;
    }
    check(explicitMissing, '显式 dcp 不存在应抛错');
    eq(explicitMissing.code, 'DCP_NOT_FOUND');
  });

  await test('MCP tools/call：14 个工具 + hw_scan/hw_program/debug_cores 端到端（fake）', async () => {
    const projDir = newFakeHwProject('mcp');
    const tclDir = newFakeTclDir('mcp-hw');
    const bit = writeFakeBit(projDir, 'mcp.bit', 128);
    const baseEnv = {
      VIVADO_PROJECT_ROOT: projDir,
      VIVADO_BIN: FAKE_VIVADO,
      VIVADO_MCP_TCL_DIR: tclDir,
      VIVADO_MCP_HW_SERVER_MODE: 'skip',
      VIVADO_MCP_ALLOW_EXTERNAL_VIVADO: '1',
    };
    const client = await McpProbeClient.connect({ args: [path.join(PACKAGE_ROOT, 'src', 'server.mjs')], cwd: projDir, env: baseEnv });
    try {
      await client.initialize({ clientInfo: { name: 'hw-probe', version: '0.0.1' } });
      const tools = await client.listTools();
      eq(tools.length, 14, 'MCP tools/list 应为 14 个工具');
      includes(tools.map((t) => t.name), 'vivado_hw_scan');
      includes(tools.map((t) => t.name), 'vivado_hw_program');
      includes(tools.map((t) => t.name), 'vivado_debug_cores');
      const programTool = tools.find((t) => t.name === 'vivado_hw_program');
      eq(JSON.stringify(programTool.inputSchema.required), JSON.stringify(['bit_file']), 'hw_program 应要求 bit_file');

      const scan = await client.callTool('vivado_hw_scan', { project_dir: projDir });
      check(!scan.isError, `hw_scan 不应 isError：${scan.content?.[0]?.text}`);
      eq(scan.structuredContent.ok, true);
      eq(scan.structuredContent.devices.length, 0);
      eq(scan.structuredContent.hwServer.skipped, true);

      const program = await client.callTool('vivado_hw_program', { bit_file: bit, project_dir: projDir });
      check(!program.isError, `hw_program 不应 isError：${program.content?.[0]?.text}`);
      eq(program.structuredContent.ok, true);
      eq(program.structuredContent.programmed, true);
      eq(program.structuredContent.bitSha256, sha256OfFile(bit));

      const noVerify = await client.callTool('vivado_hw_program', { bit_file: bit, project_dir: projDir, verify: false });
      eq(noVerify.structuredContent.verify.requested, false, 'verify=false 应传给 TCL');

      const missingBit = await client.callTool('vivado_hw_program', {});
      eq(missingBit.isError, true, '缺必填 bit_file 应为 isError');
      includes(missingBit.content[0].text, 'bit_file');

      const debug = await client.callTool('vivado_debug_cores', { project_dir: projDir });
      check(!debug.isError, `debug_cores 不应 isError：${debug.content?.[0]?.text}`);
      eq(debug.structuredContent.ok, true);
      eq(debug.structuredContent.dcpSource, 'derived');
      eq(debug.structuredContent.cores.length, 2);

      const debugNets = await client.callTool('vivado_debug_cores', { project_dir: projDir, include_nets: true });
      eq(debugNets.structuredContent.cores[0].ports[0].net, 'clk_25m');

      const hwStatus = await client.callTool('vivado_job_status', { job_id: scan.structuredContent.jobId });
      eq(hwStatus.structuredContent.kind, 'hw');
      eq(hwStatus.structuredContent.ok, true);
      const hwList = await client.callTool('vivado_job_list', { project_dir: projDir, limit: 10 });
      check(hwList.structuredContent.jobs.some((job) => job.id === scan.structuredContent.jobId), 'job_list 应包含 hw job');
    } finally {
      await client.close();
    }

    // 无设备负路径：需要 server 进程带 FAKE_HW_MODE=no-device
    const noDevClient = await McpProbeClient.connect({
      args: [path.join(PACKAGE_ROOT, 'src', 'server.mjs')],
      cwd: projDir,
      env: { ...baseEnv, FAKE_HW_MODE: 'no-device' },
    });
    try {
      await noDevClient.initialize({ clientInfo: { name: 'hw-probe-nodev', version: '0.0.1' } });
      const noDevice = await noDevClient.callTool('vivado_hw_program', { bit_file: bit, project_dir: projDir });
      eq(noDevice.isError, undefined, 'job 失败应是正常结果 + ok=false，而不是协议/工具错误');
      eq(noDevice.structuredContent.ok, false);
      includes(noDevice.structuredContent.failures.map((f) => f.code).join(','), 'NO_HW_DEVICE');
      includes(noDevice.content[0].text, '失败原因');
    } finally {
      await noDevClient.close();
    }
  });
}

// ---------------------------------------------------------------------------
// 5. CLI
// ---------------------------------------------------------------------------
function runCli(args, { env = process.env, cwd = PACKAGE_ROOT, timeoutMs = 120000 } = {}) {
  return spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'vivado-cli.mjs'), ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
}

async function testCli() {
  section('5. CLI（doctor/info/build/sim/reports/hw-*/退出码/--json）');
  const projDir = newFakeProject('cli');
  const tclDir = newFakeTclDir('cli');
  const env = fakeEnv({ projectDir: projDir, tclDir });

  await test('info --json（fake 工程只读）', async () => {
    const r = runCli(['info', '--json', '--project', projDir]);
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    const info = JSON.parse(r.stdout);
    eq(info.part, 'xc7a100tcsg324-1');
    eq(info.design.top, 'fake_dut');
    eq(info.sim.top, 'fake_tb');
  });

  await test('info 文本输出为中文', async () => {
    const r = runCli(['info', '--project', projDir]);
    eq(r.status, 0);
    includes(r.stdout, '器件');
    includes(r.stdout, 'fake_dut');
  });

  await test('doctor --json（fake vivado）可解析', async () => {
    const r = runCli(['doctor', '--json', '--project', projDir], { env });
    check(r.status === 0 || r.status === 1, `doctor exit 应为 0/1，实际 ${r.status}`);
    const report = JSON.parse(r.stdout);
    eq(report.vivado.found, true);
    eq(report.project.found, true);
    check(Array.isArray(report.checks));
  });

  await test('tbs --json（fake 工程）', async () => {
    const r = runCli(['tbs', '--json', '--project', projDir]);
    eq(r.status, 0);
    const data = JSON.parse(r.stdout);
    eq(data.activeTop, 'fake_tb');
    check(data.testbenches.find((t) => t.module === 'fake_tb').simulatable);
  });

  await test('build（bitstream）--json + --extra-xdc → exit 0 且 ok=true', async () => {
    const extra = path.join(projDir, 'extra_smoke.xdc');
    const r = runCli(['bitstream', '--json', '--project', projDir, '--extra-xdc', extra], { env, timeoutMs: 180000 });
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, true);
    eq(data.extraXdc, extra);
    check(data.bitstream && data.bitstream.exists);
  });

  await test('CLI reports：文本无 undefined/?%，JSON 含利用率百分比 + Round4 verdict/bus skew', async () => {
    // 选一个报告齐全（含 impl 时序/功耗）的 job：扫描报告目录找带 fake_timing_summary_max.rpt 的最新目录
    const reportsRoot = path.join(projDir, '.vivado-mcp', 'reports');
    const candidates = fs.readdirSync(reportsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => b.localeCompare(a));
    const fullJobId = candidates.find((name) => fs.existsSync(path.join(reportsRoot, name, 'fake_timing_summary_max.rpt')));
    check(fullJobId, '应存在含时序报告的 job 报告目录');
    const rJson = runCli(['reports', fullJobId, '--json', '--project', projDir], { env });
    eq(rJson.status, 0, `exit=${rJson.status} stderr=${rJson.stderr.slice(0, 300)}`);
    const report = JSON.parse(rJson.stdout);
    eq(report.jobId, fullJobId);
    eq(report.utilization.hasReport, true);
    eq(report.utilization.summary.lut.utilPercent, 0.02);
    eq(report.timing.hasReport, true);
    eq(report.timing.designSummary.wns, 2.907);
    eq(report.timing.reportKind, 'max');
    eq(report.verdict.timingScope, 'setup+pw');
    eq(report.verdict.setupMet, true);
    eq(report.verdict.holdAnalyzed, false);
    check(report.timing.busSkew, 'CLI JSON 应包含 bus skew 解析');
    eq(report.timing.busSkew.applicable, true);
    eq(report.verdict.busSkewMet, true);
    const rText = runCli(['reports', fullJobId, '--project', projDir], { env });
    eq(rText.status, 0);
    check(!/undefined/.test(rText.stdout), 'reports 文本不应出现 undefined');
    check(!/\(\?%\)/.test(rText.stdout), 'reports 文本不应出现 ?%');
    includes(rText.stdout, '0.02%');
    includes(rText.stdout, '时序判定（setup+pulseWidth（不含 hold））');
    includes(rText.stdout, 'bus skew 判定：满足');
    includes(rText.stdout, '范围=setup+pulseWidth（不含 hold）');
  });

  await test('bin/vivado.bat 转发 CLI 且退出码正确（0/2）', async () => {
    const bat = path.join(PACKAGE_ROOT, 'bin', 'vivado.bat');
    if (!fs.existsSync(bat)) {
      skip('bin/vivado.bat 转发', 'wrapper 不存在');
      return;
    }
    // 与工具链内部一致的 Windows .bat 调用方式：cmd.exe /d /s /c + 外层引号
    const invokeBat = (args) => {
      const quote = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
      const line = [`"${bat}"`, ...args.map(quote)].join(' ');
      return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        windowsVerbatimArguments: true,
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
    };
    const ok = invokeBat(['info', '--json', '--project', projDir]);
    eq(ok.status, 0, `info via wrapper exit=${ok.status} stderr=${String(ok.stderr || '').slice(0, 300)}`);
    eq(JSON.parse(ok.stdout).part, 'xc7a100tcsg324-1');
    const bad = invokeBat(['info', '--nope']);
    eq(bad.status, 2, `非法参数 via wrapper 应 exit 2，实际 ${bad.status}`);
  });

  await test('build（bitstream，DRC 负路径）→ exit 3 且 ok=false', async () => {
    const r = runCli(['bitstream', '--json', '--project', projDir], {
      env: { ...env, FAKE_VIVADO_MODE: 'drc' },
      timeoutMs: 180000,
    });
    eq(r.status, 3, `exit 应为 3，实际 ${r.status}（stderr=${r.stderr.slice(0, 300)}）`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, false);
    includes(data.failures.map((f) => f.code), 'DRC_NSTD-1');
    eq(data.failedStage, 'write_bitstream');
  });

  await test('参数错误 → exit 2（未知命令/非法选项/非法数值）', async () => {
    eq(runCli(['not-a-command']).status, 2);
    eq(runCli(['info', '--nope']).status, 2);
    eq(runCli(['sim', '--jobs', 'abc']).status, 2);
  });

  await test('不存在的 job → exit 1（环境错误）', async () => {
    const r = runCli(['status', 'nonexistent-job', '--project', projDir], { env });
    eq(r.status, 1);
    includes(r.stderr, '未找到 job');
  });

  await test('仿真 CLI（fake）：sim → exit 0', async () => {
    const r = runCli(['sim', '--json', '--project', projDir], {
      env: { ...env, FAKE_XSIM_MODE: 'ok', FAKE_XELAB_MODE: undefined, FAKE_XVLOG_MODE: undefined },
      timeoutMs: 180000,
    });
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, true);
    eq(data.sim.passCount, 6);
  });

  // ---- Round 3：调试类 CLI ----
  const hwProjDir = newFakeHwProject('cli-hw');
  const hwTclDir = newFakeTclDir('cli-hw');
  const hwE = hwEnv({ projectDir: hwProjDir, tclDir: hwTclDir });
  const hwBit = writeFakeBit(hwProjDir, 'cli.bit', 256);

  await test('CLI hw-scan --json → exit 0，devices=[]', async () => {
    const r = runCli(['hw-scan', '--json', '--project', hwProjDir], { env: hwE });
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, true);
    eq(data.devices.length, 0);
    eq(data.hwServer.skipped, true);
    check(data.jobId.includes('-hw-scan-'));
  });

  await test('CLI hw-program --json/--no-verify + SHA256 → exit 0', async () => {
    const r = runCli(['hw-program', '--bit', hwBit, '--json', '--project', hwProjDir], { env: hwE, timeoutMs: 180000 });
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, true);
    eq(data.programmed, true);
    eq(data.bitSha256, sha256OfFile(hwBit));
    const noVerify = runCli(['hw-program', '--bit', hwBit, '--no-verify', '--json', '--project', hwProjDir], { env: hwE, timeoutMs: 180000 });
    eq(noVerify.status, 0);
    eq(JSON.parse(noVerify.stdout).verify.requested, false);
  });

  await test('CLI hw-program 无设备 → exit 3 且 failures 含 NO_HW_DEVICE', async () => {
    const r = runCli(['hw-program', '--bit', hwBit, '--json', '--project', hwProjDir], {
      env: { ...hwE, FAKE_HW_MODE: 'no-device' },
      timeoutMs: 180000,
    });
    eq(r.status, 3, `exit 应为 3，实际 ${r.status}（stderr=${r.stderr.slice(0, 300)}）`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, false);
    includes(data.failures.map((f) => f.code), 'NO_HW_DEVICE');
  });

  await test('CLI debug-cores --json / --include-nets → exit 0', async () => {
    const r = runCli(['debug-cores', '--json', '--project', hwProjDir], { env: hwE, timeoutMs: 180000 });
    eq(r.status, 0, `exit=${r.status} stderr=${r.stderr.slice(0, 400)}`);
    const data = JSON.parse(r.stdout);
    eq(data.ok, true);
    eq(data.dcpSource, 'derived');
    eq(data.cores.length, 2);
    check(!('net' in data.cores[0].ports[0]));
    const withNets = runCli(['debug-cores', '--json', '--include-nets', '--project', hwProjDir], { env: hwE, timeoutMs: 180000 });
    eq(withNets.status, 0);
    eq(JSON.parse(withNets.stdout).cores[0].ports[0].net, 'clk_25m');
    const text = runCli(['debug-cores', '--project', hwProjDir], { env: hwE, timeoutMs: 180000 });
    eq(text.status, 0);
    includes(text.stdout, 'debug cores：2 个');
    check(!/undefined/.test(text.stdout), `CLI 文本不应出现 undefined：\n${text.stdout}`);
  });

  await test('CLI hw-program 缺 --bit → exit 2（参数错误）', async () => {
    const r = runCli(['hw-program', '--json', '--project', hwProjDir], { env: hwE });
    eq(r.status, 2);
    includes(r.stderr, '--bit');
  });
}

// ---------------------------------------------------------------------------
// 6. 包与 bundle 文件
// ---------------------------------------------------------------------------
async function testPackageFiles() {
  section('6. 包与 bundle 文件完整性');
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));

  await test('package.json：名称/私有/ESM/exports/dsh.bundle.patch/files', () => {
    eq(pkg.name, 'dsh-vivado-plugin');
    eq(pkg.type, 'module');
    eq(pkg.dsh.bundle.patch, './cordis.patch.yml');
    eq(pkg.exports['./locale/*.json'], './locale/*.json');
    eq(pkg.exports['./icon'], './icon.svg');
    for (const need of ['index.mjs', 'src', 'bin', 'test', 'tcl', 'locale', 'docs', 'cordis.patch.yml', 'icon.svg']) {
      includes(pkg.files, need, `files 应包含 ${need}`);
    }
  });

  await test('locale：en/zh JSON 合法且含 meta.title/description（T3 内容）', () => {
    for (const lang of ['en', 'zh']) {
      const data = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'locale', `${lang}.json`), 'utf8'));
      check(data.meta && typeof data.meta.title === 'string' && data.meta.title.length > 0, `${lang}.meta.title 应为非空字符串`);
      check(typeof data.meta.description === 'string' && data.meta.description.length > 0, `${lang}.meta.description 应为非空字符串`);
    }
  });

  await test('icon.svg：原创 SVG（含 <svg 与 aria-label）', () => {
    const svg = fs.readFileSync(path.join(PACKAGE_ROOT, 'icon.svg'), 'utf8');
    includes(svg, '<svg');
    includes(svg, 'aria-label');
    check(svg.length > 300, 'icon.svg 内容过短');
  });

  await test('cordis.patch.yml：native plugin row（无私有配置/绝对路径）', () => {
    const yml = fs.readFileSync(path.join(PACKAGE_ROOT, 'cordis.patch.yml'), 'utf8');
    includes(yml, 'id: vivado-plugin');
    includes(yml, 'name: dsh-vivado-plugin');
    check(!/[A-Za-z]:\\[^\n]*\\/.test(yml), 'cordis.patch.yml 不应包含本机绝对路径');
    check(!/private-project|project-code/i.test(yml), 'cordis.patch.yml 不应包含项目代号');
  });

  await test('instructions ≤ 8KB 且含关键工具名', () => {
    const bytes = Buffer.byteLength(INSTRUCTIONS, 'utf8');
    check(bytes <= 8192, `instructions 必须 ≤8192 字节，实际 ${bytes}`);
    for (const tool of ['vivado_doctor', 'vivado_project_info', 'vivado_build_start', 'vivado_job_wait', 'vivado_reports', 'vivado_hw_scan', 'vivado_hw_program', 'vivado_debug_cores']) {
      includes(INSTRUCTIONS, tool);
    }
  });

  await test('test/README.md 与可复跑命令存在', () => {
    const readme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    includes(readme, 'run-tests.mjs');
    includes(readme, 'plugin-tests.mjs');
  });
}

// ---------------------------------------------------------------------------
// 7. 可选：真实 MCP SDK 客户端握手
// ---------------------------------------------------------------------------
function findRealSdkClient() {
  if (process.env.MCP_CLIENT_SDK_PATH) return process.env.MCP_CLIENT_SDK_PATH;
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'npm-cache', '_npx'),
  ];
  for (const base of candidates) {
    try {
      for (const dir of fs.readdirSync(base)) {
        const clientDir = path.join(base, dir, 'node_modules', '@modelcontextprotocol', 'client');
        if (fs.existsSync(path.join(clientDir, 'dist', 'index.mjs'))) return path.join(clientDir, 'dist', 'index.mjs');
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function testRealSdkOptional() {
  section('7. 真实 MCP SDK 客户端握手（与 DSH mcp-client 同款 @modelcontextprotocol/client）');
  if (process.env.VIVADO_MCP_SKIP_SDK === '1') {
    skip('@modelcontextprotocol/client 握手', 'VIVADO_MCP_SKIP_SDK=1');
    return;
  }
  const sdkIndex = findRealSdkClient();
  if (!sdkIndex) {
    skip('@modelcontextprotocol/client 握手', '本机未找到 @modelcontextprotocol/client（可用 MCP_CLIENT_SDK_PATH 指定）');
    return;
  }
  const projDir = newFakeProject('sdk');
  await test(`真实 SDK 客户端握手（${path.basename(path.dirname(path.dirname(sdkIndex)))}）`, async () => {
    const { pathToFileURL } = await import('node:url');
    const sdk = await import(pathToFileURL(sdkIndex).href);
    const stdioPath = path.join(path.dirname(sdkIndex), 'stdio.mjs');
    const stdio = await import(pathToFileURL(stdioPath).href);
    const { Client } = sdk;
    check(typeof Client === 'function', 'SDK 应导出 Client');
    check(typeof stdio.StdioClientTransport === 'function', 'SDK 应导出 StdioClientTransport');
    // 与 @deepseek-ai/dsh-mcp-client 的用法保持一致（2 参数构造 + versionNegotiation auto + cacheMode refresh）
    const client = new Client(
      { name: 'vivado-mcp-sdk-probe', version: '0.0.1' },
      {
        capabilities: {},
        versionNegotiation: { mode: 'auto' },
        listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {} } },
      },
    );
    const transport = new stdio.StdioClientTransport({
      command: process.execPath,
      args: [path.join(PACKAGE_ROOT, 'src', 'server.mjs')],
      cwd: projDir,
      env: {
        ...process.env,
        VIVADO_PROJECT_ROOT: projDir,
        VIVADO_BIN: FAKE_VIVADO,
        VIVADO_MCP_ALLOW_EXTERNAL_VIVADO: '1',
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      eq(client.getServerCapabilities()?.tools?.listChanged, false);
      const tools = await client.listTools(undefined, { cacheMode: 'refresh' });
      eq(tools.tools.length, 14);
      includes(
        tools.tools.map((t) => t.name),
        'vivado_project_info',
      );
      includes(
        tools.tools.map((t) => t.name),
        'vivado_hw_scan',
      );
      const info = await client.callTool({ name: 'vivado_project_info', arguments: {} }, { timeout: 30000 });
      check(!info.isError, 'isError 不应为 true');
      includes(info.content?.[0]?.text || '', 'xc7a100tcsg324-1');
      eq(info.structuredContent?.part, 'xc7a100tcsg324-1');
      const bad = await client.callTool({ name: 'vivado_project_info', arguments: { project_dir: 123 } }, { timeout: 30000 });
      eq(bad.isError, true);
    } finally {
      await client.close().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  process.stdout.write(`Vivado toolchain offline tests\npackage: ${PACKAGE_ROOT}\ntmp: ${TMP_ROOT}\n`);
  try {
    await testParsers();
    await testMcpProtocol();
    await testFakeJobs();
    await testHwTools();
    await testCli();
    await testPackageFiles();
    await testRealSdkOptional();
  } finally {
    // 清理临时目录（保留失败现场：有失败时不删，便于排查）
    if (failCount === 0) {
      try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else {
      process.stdout.write(`\n测试失败，保留临时目录：${TMP_ROOT}\n`);
    }
  }

  const elapsed = ((Date.now() - suiteStarted) / 1000).toFixed(1);
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`结果：${passCount} 通过，${failCount} 失败，${skipCount} 跳过（耗时 ${elapsed}s）\n`);
  if (failCount > 0) {
    process.stdout.write('\n失败列表：\n');
    for (const item of failures) process.stdout.write(`  ✗ ${item.name}\n`);
    process.exit(1);
  }
  process.stdout.write('全部通过 ✅\n');
}

main().catch((err) => {
  console.error('测试框架异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
