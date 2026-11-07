// 离线 fake Vivado / xvlog / xelab / xsim 测试替身：模拟真实批处理日志、报告、bit 产物与退出码。
// 通过环境变量控制行为：
//   FAKE_VIVADO_MODE = ok | drc | fail          （drc：impl 后在 write_bitstream 报 DRC 两条 ERROR 并失败）
//   FAKE_VIVADO_SLEEP_MS = 毫秒                  （模拟长构建，用于 cancel/并发测试）
//   FAKE_XSIM_MODE = ok | fail                   （fail：退出码 0 但日志有 6 条 Error，模拟当前载体 TB 的真实负路径）
//   FAKE_XVLOG_MODE / FAKE_XELAB_MODE = fail      （模拟编译/精化失败）
//   FAKE_HW_MODE = ok | no-device | fail          （调试 TCL：no-device→hw_program NO_HW_DEVICE；fail→hw_scan HW_CONNECT_FAILED）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(here, '..', 'logs');
const HW_DIR = path.resolve(here, '..', 'hw');

const argv = process.argv.slice(2);
const tool = argv.shift();
const env = process.env;

function out(line) {
  process.stdout.write(`${line}\n`);
}
function errOut(line) {
  process.stderr.write(`${line}\n`);
}
function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function copyTemplate(name, dest) {
  ensureDir(path.dirname(dest));
  let text = '';
  try {
    text = fs.readFileSync(path.join(LOG_DIR, name), 'utf8');
  } catch {
    text = `# missing template ${name}\n`;
  }
  fs.writeFileSync(dest, text);
}
function readHwFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(HW_DIR, name), 'utf8'));
}
function writeHwJson(json) {
  const jsonOut = env.VMCP_JSON_OUT;
  if (!jsonOut) {
    errOut('[fake-tool] 缺少 VMCP_JSON_OUT');
    process.exit(2);
  }
  ensureDir(path.dirname(jsonOut));
  fs.writeFileSync(jsonOut, JSON.stringify(json, null, 1) + '\n', 'utf8');
  return jsonOut;
}

/**
 * 硬件调试 TCL 的 fake 行为（按 -source 脚本名分派）：
 *   hw_scan.tcl   → FAKE_HW_MODE=fail 时 scan-fail.json，否则 scan-ok.json
 *   hw_program.tcl→ FAKE_HW_MODE=no-device|fail 时 program-no-device.json，否则 program-ok.json
 *   debug_cores.tcl → debug-cores.json（VMCP_INCLUDE_NETS=1 时保留 net 字段）
 * 都写 VMCP_JSON_OUT 并打印 SPEC_debug §2 的标记行。
 */
function runFakeHwTcl(sourceTcl) {
  out('INFO: [Common 17-1131] Fake Vivado (offline test double, hardware mode)');
  out(`INFO: [Fake] source=${sourceTcl} json_out=${env.VMCP_JSON_OUT || ''}`);
  out(
    `INFO: [Fake] hw_server=${env.VMCP_HW_SERVER_URL || ''} bit=${env.VMCP_BIT_FILE || ''} device=${env.VMCP_HW_DEVICE || ''} verify=${env.VMCP_VERIFY || ''} dcp=${env.VMCP_DCP_FILE || ''} include_nets=${env.VMCP_INCLUDE_NETS || ''}`,
  );
  const hwMode = String(env.FAKE_HW_MODE || 'ok').toLowerCase();
  let json;
  let exitCode = 0;

  if (sourceTcl === 'hw_scan.tcl') {
    if (hwMode === 'fail') {
      json = readHwFixture('scan-fail.json');
      exitCode = 1;
      out('ERROR: [Labtools 27-2269] Fake hw connect failure (fixture)');
      out('VMCP_ERROR HW_CONNECT_FAILED fake');
    } else {
      json = readHwFixture('scan-ok.json');
    }
    if (env.VMCP_HW_SERVER_URL) json.hwServer = { ...(json.hwServer || {}), url: env.VMCP_HW_SERVER_URL };
    const targets = Array.isArray(json.targets) ? json.targets.length : 0;
    const devices = Array.isArray(json.devices) ? json.devices.length : 0;
    out(`VMCP_HW_DONE targets=${targets} devices=${devices}`);
  } else if (sourceTcl === 'hw_program.tcl') {
    if (hwMode === 'no-device' || hwMode === 'fail') {
      json = readHwFixture('program-no-device.json');
      exitCode = 1;
      out('ERROR: [Labtools 27-3164] No programmable device found (fixture)');
      out('VMCP_ERROR No programmable device found（本机无板卡，fixture）');
    } else {
      json = readHwFixture('program-ok.json');
      if (Array.isArray(json.errors)) json.errors = [];
    }
    json.bitFile = env.VMCP_BIT_FILE || json.bitFile || '';
    if (env.VMCP_VERIFY === '0' && json.verify) json.verify = { requested: false, passed: null, detail: 'verify disabled' };
    out(`VMCP_PROGRAM_DONE programmed=${json.programmed ? 1 : 0}`);
  } else if (sourceTcl === 'debug_cores.tcl') {
    json = readHwFixture('debug-cores.json');
    json.dcp = env.VMCP_DCP_FILE || json.dcp || '';
    if (String(env.VMCP_INCLUDE_NETS || '0') !== '1') {
      for (const core of json.cores || []) {
        for (const port of core.ports || []) delete port.net;
      }
    }
    const cores = Array.isArray(json.cores) ? json.cores.length : 0;
    out(`VMCP_DEBUG_DONE cores=${cores}`);
  } else {
    errOut(`[fake-tool] 未知硬件 TCL：${sourceTcl}`);
    process.exit(2);
  }

  const jsonOut = writeHwJson(json);
  out(`VMCP_RESULT_JSON ${jsonOut}`);
  out(`VMCP_FINISH ${exitCode === 0 && json.ok !== false ? 'ok' : 'fail'}`);
  process.exit(exitCode === 0 && json.ok !== false ? 0 : 1);
}

const stage = String(env.VMCP_STAGE || 'full').toLowerCase();
const projectDir = env.VMCP_PROJECT_DIR || process.cwd();
const reportDir = env.VMCP_REPORT_DIR || path.join(projectDir, '.vivado-mcp', 'reports', 'fake');
const mode = String(env.FAKE_VIVADO_MODE || 'ok').toLowerCase();
const bitPath = path.join(projectDir, 'Fake.runs', 'impl_1', 'fake_dut.bit');

const SIM_LABELS = [
  'no-parity basic',
  'no-parity back-to-back first',
  'no-parity back-to-back second',
  'no-parity stop-bit violation',
  'even-parity valid',
  'even-parity mismatch',
];

switch (tool) {
  case 'vivado': {
    // 支持 `vivado.bat -version`（doctor 版本探测用，不写任何文件）
    if (argv.includes('-version') || argv.includes('--version')) {
      out('Vivado v2018.3 (64-bit)');
      out('SW Build 2405991 on Thu Dec  6 23:38:27 MST 2018');
      out('IP Build 2404404 on Fri Dec  7 01:43:56 MST 2018');
      out('Copyright 1986-2018 Xilinx, Inc. All Rights Reserved.');
      process.exit(0);
    }
    // 硬件调试 TCL（Round 3）：按 -source 脚本名走 fake 硬件行为
    const sourceIdx = argv.indexOf('-source');
    const sourceTcl = sourceIdx >= 0 ? path.basename(String(argv[sourceIdx + 1] || '')) : '';
    if (sourceTcl === 'hw_scan.tcl' || sourceTcl === 'hw_program.tcl' || sourceTcl === 'debug_cores.tcl') {
      runFakeHwTcl(sourceTcl);
    }
    out('INFO: [Common 17-1131] Fake Vivado (offline test double)');
    out(`INFO: [Fake] stage=${stage} mode=${mode}`);
    out(`INFO: [Fake] project=${projectDir}`);
    out(`INFO: [Fake] xpr=${env.VMCP_XPR || ''} jobs=${env.VMCP_JOBS || ''}`);
    out(`INFO: [Fake] report_dir=${reportDir}`);
    if (env.VMCP_XPR_BACKUP) out(`INFO: [Fake] server xpr backup=${env.VMCP_XPR_BACKUP}`);
    if (env.VMCP_EXTRA_XDC) out(`INFO: [Fake] injected extra xdc (in-memory only): ${env.VMCP_EXTRA_XDC}`);
    // 模拟“Vivado 打开工程后改写了 xpr”，用于验证 job 结束后的 xpr 恢复逻辑
    if (String(env.FAKE_VIVADO_MUTATE_XPR || '') === '1' && env.VMCP_XPR) {
      try {
        fs.appendFileSync(env.VMCP_XPR, '\n<!-- mutated by fake vivado (fixture) -->\n');
        out('INFO: [Fake] mutated xpr (to verify restore)');
      } catch {
        /* ignore */
      }
    }
    out('PROGRESS: 3%');
    const sleepMs = Number(env.FAKE_VIVADO_SLEEP_MS || 0);
    if (sleepMs > 0) {
      out(`INFO: [Fake] sleeping ${sleepMs}ms`);
      sleep(sleepMs);
    }
    if (mode === 'fail') {
      out('INFO: [Vivado 12-1411] Starting synth_design');
      out('ERROR: [Synth 8-7071] Fake synthesis failure (fixture)');
      out('VMCP_ERROR Fake synth failure (fixture)');
      out('VMCP_FINISH fail');
      process.exit(1);
    }

    // Round 4 防御回归：模拟 runs/<run>/runme.log 跨 reset 回放历史 flow 的 ERROR
    // （stale-error：历史 ERROR 之后当前 flow 成功；stale-error-active：历史 ERROR + 当前 flow 也有 ERROR）
    if (mode === 'stale-error' || mode === 'stale-error-active') {
      out('INFO: [Common 17-206] Exiting Vivado at Mon Oct 19 07:43:47 2026...');
      out("ERROR: [DRC NSTD-1] Unspecified I/O Standard: stale replay from previous failed flow (fixture)");
      out("ERROR: [DRC UCIO-1] Unconstrained Logical Port: stale replay from previous failed flow (fixture)");
      out('INFO: [Common 17-206] Exiting Vivado at Mon Oct 19 08:10:06 2026...');
    }

    // 生成报告（模拟 T1 tcl 写到 VMCP_REPORT_DIR）
    ensureDir(reportDir);
    copyTemplate('utilization.rpt', path.join(reportDir, 'fake_utilization.rpt'));
    if (stage !== 'synth') {
      // Round 4：默认 max 报告；FAKE_TIMING_REPORT 可切换为 min_max（含 WHS/THS）以覆盖 hold 判定
      const timingTemplate = String(env.FAKE_TIMING_REPORT || 'timing_summary.rpt');
      copyTemplate(timingTemplate, path.join(reportDir, 'fake_timing_summary_max.rpt'));
      copyTemplate('power.rpt', path.join(reportDir, 'fake_power.rpt'));
      // 模拟 T1 的 report_bus_skew 产物（文件名含 bus_skew 以便 reports 分类）
      if (String(env.FAKE_BUS_SKEW || 'clean').toLowerCase() !== 'none') {
        copyTemplate(String(env.FAKE_BUS_SKEW === 'empty' ? 'bus_skew_empty.rpt' : 'bus_skew_clean.rpt'), path.join(reportDir, 'fake_bus_skew_routed.rpt'));
      }
    }
    out(`VMCP_REPORT ${path.join(reportDir, 'fake_utilization.rpt')}`);

    if (stage === 'synth') {
      out('INFO: [Vivado 12-1411] Starting synth_design');
      out('PROGRESS: 55%');
      out('INFO: [Synth 8-256] done in 1.2 s');
      out('Synthesis finished with 0 errors, 3 warnings and 2 critical warnings.');
      out('synth_design completed successfully');
      out('VMCP_SYNTH_DONE progress=100% status=Complete!');
      out('VMCP_FINISH ok');
      out('INFO: [Common 17-206] Exiting Vivado at Wed Oct 22 11:40:58 2025...');
      process.exit(0);
    }

    if (stage === 'full') {
      out('INFO: [Fake] phase 1/2: synthesis');
      out('PROGRESS: 25%');
      out('VMCP_SYNTH_DONE progress=100% status=Complete!');
    }
    out('INFO: [Fake] phase impl: launch_runs impl -to_step write_bitstream');
    out('PROGRESS: 60%');
    out('INFO: [Place 30-...] place_design completed successfully');
    out('INFO: [Route 35-...] route_design completed successfully');
    out('VMCP_IMPL_DONE progress=100% status=Complete!');
    if (mode === 'stale-error-active') {
      // 当前 flow 的真实 ERROR（发生首个 VMCP 标记之后）→ 必须仍判失败
      out('ERROR: [Fake 99-0001] current-flow synthetic error after VMCP marker (fixture)');
    }

    if (stage === 'impl') {
      out('VMCP_FINISH ok');
      process.exit(0);
    }

    if (mode === 'drc') {
      out('INFO: [Vivado 12-1431] write_bitstream');
      out("ERROR: [DRC NSTD-1] Unspecified I/O Standard: 16 out of 16 logical ports use I/O standard (IOSTANDARD) value 'DEFAULT', instead of a user-assigned I/O standard.");
      out('Resolution: The I/O standard must be specified with the IOSTANDARD property on the port, or a correct XDC constraint must be added.');
      out('ERROR: [DRC UCIO-1] Unconstrained Logical Port: 16 out of 16 logical ports have no user assigned specific location constraint (LOC).');
      out('Resolution: Assign an explicit LOC constraint to each port, or use a correct XDC constraint file for the current top.');
      out('VMCP_ERROR write_bitstream 被 DRC 拒绝（默认 XDC 与当前 top 不匹配）');
      out('VMCP_FINISH fail');
      process.exit(1);
    }

    out('INFO: [Fake] write_bitstream');
    out('PROGRESS: 95%');
    ensureDir(path.dirname(bitPath));
    fs.writeFileSync(bitPath, Buffer.alloc(1024, 0x5a));
    out(`VMCP_BITSTREAM_OK ${bitPath}`);
    out('VMCP_FINISH ok');
    out('INFO: [Common 17-206] Exiting Vivado at Wed Oct 22 11:45:00 2025...');
    process.exit(0);
    break;
  }
  case 'xvlog': {
    out(`INFO: [Fake] xvlog ${argv.join(' ')}`);
    if (String(env.FAKE_XVLOG_MODE || '').toLowerCase() === 'fail') {
      out('ERROR: [VRFC 10-2994] fake compile error (fixture)');
      process.exit(1);
    }
    ensureDir(path.join(process.cwd(), 'xsim.dir', 'xil_defaultlib'));
    out('INFO: [Fake] xvlog done');
    process.exit(0);
    break;
  }
  case 'xelab': {
    out(`INFO: [Fake] xelab ${argv.join(' ')}`);
    if (String(env.FAKE_XELAB_MODE || '').toLowerCase() === 'fail') {
      out('ERROR: [XSIM 43-3321] fake elaboration error (fixture)');
      process.exit(1);
    }
    out('INFO: [Fake] xelab done');
    process.exit(0);
    break;
  }
  case 'xsim': {
    out(`INFO: [Fake] xsim ${argv.join(' ')}`);
    const xsimMode = String(env.FAKE_XSIM_MODE || 'ok').toLowerCase();
    if (xsimMode === 'fail') {
      // 真实载体 TB 的负路径：运行期 $error 打印 Error，xsim 退出码仍为 0
      for (const label of SIM_LABELS) {
        out('[TEST] fixture case');
        out(`Error: ${label}: timeout waiting for o_dv assertion`);
      }
      out('All fake tests completed');
      out('INFO: [USR-XSim-96] XSim completed.');
      process.exit(0);
    }
    for (const label of SIM_LABELS) {
      out('[TEST] fixture case');
      out(`[PASS] ${label}`);
    }
    out('All fake tests completed');
    out('INFO: [USR-XSim-96] XSim completed.');
    process.exit(0);
    break;
  }
  default: {
    errOut(`[fake-tool] 未知工具：${tool}`);
    process.exit(2);
  }
}
