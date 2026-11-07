// 仿真：xvlog → xelab → xsim 全流程异步 job（不打开工程、不占工程锁、独立工作目录）。
// 命令依据 T1 在本机实测（Vivado 2018.3）：
//   xvlog.bat -sv -work work <全部设计源> <TB>
//   xelab.bat -debug typical -s <snapshot> work.<tb_module>
//   xsim.bat <snapshot> -runall
import path from 'node:path';
import { createProjectContext, resolveProject } from './config.mjs';
import { envError } from './errors.mjs';
import { createJob, getJobStatus, waitJob } from './jobs.mjs';
import { parseErrors, parseSimResult } from './parse.mjs';
import { designFileSet, parseXpr, resolveTestbench } from './project.mjs';
import { findCompanionTools, findVivadoCandidates } from './vivado.mjs';
import { humanBytes, pathExists, readTail, statOrNull, uniqueBy } from './util.mjs';

export const SIM_TIMEOUT_DEFAULT_SEC = 900;
export const SIM_TIMEOUT_MIN_SEC = 30;
export const SIM_TIMEOUT_MAX_SEC = 7200;

const HDL_EXT = new Set(['.v', '.sv']);

function sanitizeSnapshot(name) {
  const s = String(name || 'snap').replace(/[^A-Za-z0-9_]/g, '_');
  return s.length > 120 ? s.slice(0, 120) : s;
}

function clampTimeout(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return SIM_TIMEOUT_DEFAULT_SEC;
  return Math.max(SIM_TIMEOUT_MIN_SEC, Math.min(SIM_TIMEOUT_MAX_SEC, Math.round(n)));
}

/**
 * 启动仿真 job（异步，立即返回 job_id）。
 * @returns {Promise<{job:object, ctx:object, testbench:object, commands:object, snapshot:string, workDir:string}>}
 */
export async function startSimJob({
  projectDir,
  testbench = null,
  timeoutSec = SIM_TIMEOUT_DEFAULT_SEC,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const resolved = await resolveProject({ projectDir, env, cwd });
  const ctx = createProjectContext(resolved.projectDir, resolved.xprPath);
  const tb = await resolveTestbench({ projectDir: resolved.projectDir, testbench, env, cwd });
  if (tb.language === 'vhdl') {
    throw envError('暂不支持 VHDL 测试平台自动编译', '请用 Verilog/SystemVerilog testbench，或手工在 Vivado 里仿真。');
  }

  const found = await findVivadoCandidates({ env });
  if (found.results.length === 0) {
    throw envError(
      '未找到 Vivado（无法定位 xvlog/xelab/xsim）',
      '设置环境变量 VIVADO_BIN=<Vivado bin 目录或 vivado.bat 路径>，例如 D:\\Xilinx\\Vivado\\2018.3\\bin\\vivado.bat。',
    );
  }
  const vivadoBin = found.results[0].path;
  const companions = await findCompanionTools(vivadoBin);
  if (!companions || !companions.allPresent) {
    throw envError(
      `Vivado 同目录下缺少仿真工具：${(companions && companions.missing ? companions.missing.join(', ') : 'xvlog/xelab/xsim')}`,
      `确认 ${path.dirname(vivadoBin)} 下有 xvlog.bat / xelab.bat / xsim.bat；必要时重装/修复 Vivado。`,
    );
  }

  // 设计源：按 T1 实测全量编译 sources_1 的 .v/.sv（本项目 5 个 .v），TB 单独追加
  const parsed = parseXpr(ctx.xprPath, ctx);
  const designSet = designFileSet(parsed);
  const designSources = (designSet ? designSet.files : []).filter((f) => HDL_EXT.has(f.ext));
  const fileList = uniqueBy(
    [...designSources.map((f) => f.path), tb.file].map((p) => path.resolve(p)),
    (p) => p.toLowerCase(),
  );
  const missing = [];
  for (const file of fileList) {
    if (!(await pathExists(file))) missing.push(file);
  }
  if (missing.length > 0) {
    throw envError(
      `仿真源文件缺失：${missing.map((p) => path.relative(ctx.projectDir, p)).join(', ')}`,
      '检查 xpr 里记录的文件是否真实存在（工程可能从其它机器拷贝而来）。',
    );
  }

  const moduleName = tb.module || path.basename(tb.file, path.extname(tb.file));
  const snapshot = sanitizeSnapshot(`snap_${moduleName}`);
  const timeout = clampTimeout(timeoutSec);
  const commands = {
    xvlog: { file: companions.xvlog, args: ['-sv', '-work', 'work', ...fileList] },
    xelab: { file: companions.xelab, args: ['-debug', 'typical', '-s', snapshot, `work.${moduleName}`] },
    xsim: { file: companions.xsim, args: [snapshot, '-runall'] },
  };
  const banner = [
    `# Vivado MCP 仿真 job`,
    `# testbench: ${moduleName} (${path.relative(ctx.projectDir, tb.file)})`,
    `# workdir: <job>/simwork（独立目录，不打开工程）`,
    `# xvlog: ${path.basename(commands.xvlog.file)} ${commands.xvlog.args.join(' ')}`,
    `# xelab: ${path.basename(commands.xelab.file)} ${commands.xelab.args.join(' ')}`,
    `# xsim : ${path.basename(commands.xsim.file)} ${commands.xsim.args.join(' ')}`,
    `# 判定：退出码 0 且日志 [PASS]>0、Error 数为 0 才算通过（xsim 退出码 0 不代表测试通过）。`,
  ].join('\n');

  const created = await createJob({
    ctx,
    kind: 'sim',
    stage: 'sim',
    stepsFactory: (jobDir) => {
      const simwork = path.join(jobDir, 'simwork');
      return [
        { name: 'xvlog', file: companions.xvlog, args: commands.xvlog.args, cwd: simwork },
        { name: 'xelab', file: companions.xelab, args: commands.xelab.args, cwd: simwork },
        { name: 'xsim', file: companions.xsim, args: commands.xsim.args, cwd: simwork },
      ];
    },
    env: {
      VIVADO_BIN: vivadoBin,
      VMCP_SIM_TB: moduleName,
    },
    timeoutSec: timeout,
    reportDir: null,
    commandLabel: { file: companions.xvlog, args: commands.xvlog.args },
    meta: {
      testbench: moduleName,
      testbenchFile: tb.file,
      snapshot,
      workDirName: 'simwork',
      files: fileList.map((p) => path.relative(ctx.projectDir, p)),
      mode: 'xvlog+xelab+xsim（独立工作目录）',
    },
    banner,
  });

  return {
    job: created.job,
    jobDir: created.jobDir,
    ctx,
    testbench: tb,
    vivadoBin,
    companions,
    commands,
    snapshot,
    workDir: path.join(created.jobDir, 'simwork'),
  };
}

/** 把 stderr 的关键行也加进失败信息（xvlog/xelab 错误一般在 stderr） */
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

/**
 * 按日志 + 退出码 + 标记综合判定仿真结果（禁止“退出码 0 就成功”）。
 * @param {Awaited<ReturnType<typeof getJobStatus>>} status
 */
export async function evaluateSimJob(status) {
  const text = await readTail(status.logFile, 1024 * 1024);
  const sim = parseSimResult(text);
  const toolErrors = parseErrors(text);
  const failures = [...(status.failures || [])];

  let ok = false;
  if (status.status === 'done' && status.exitCode === 0) {
    if (sim.errorCount > 0) {
      const brief = sim.errors
        .slice(0, 3)
        .map((e) => e.message.slice(0, 160))
        .join('；');
      failures.push({
        code: 'SIM_ERRORS',
        message: `仿真运行期出现 ${sim.errorCount} 个 Error：${brief}${sim.errorCount > 3 ? ' …' : ''}`,
        errorLabels: sim.errorLabels,
      });
    }
    if (sim.failLabels.length > 0) {
      failures.push({ code: 'SIM_FAIL_TAGS', message: `日志出现 ${sim.failLabels.length} 个 [FAIL]：${sim.failLabels.slice(0, 10).join('；')}` });
    }
    if (sim.passCount === 0) {
      failures.push({ code: 'SIM_NO_PASS', message: '日志中没有 [PASS] 用例标记，不能判定通过（xsim 退出码 0 不代表测试通过）' });
    }
    if (status.status === 'done' && !sim.finished) {
      failures.push({ code: 'SIM_NOT_FINISHED', message: '仿真日志中没有检测到正常结束标记（$finish / XSim completed）' });
    }
    ok = failures.length === 0 && sim.passCount > 0 && sim.errorCount === 0;
  } else {
    if (status.status === 'cancelled') {
      failures.push({ code: 'CANCELLED', message: '仿真 job 已被取消' });
    } else if (status.status !== 'done') {
      failures.push({
        code: 'SIM_JOB_FAILED',
        message: `仿真 job 状态=${status.status}${status.exitCode != null ? `，退出码=${status.exitCode}` : ''}`,
      });
    }
    for (const item of toolErrors.errors.slice(0, 10)) {
      failures.push({ code: 'XSIM_LOG_ERROR', message: item.message });
    }
    for (const item of sim.errors.slice(0, 10)) {
      failures.push({ code: 'SIM_ERROR', message: item.message });
    }
  }

  const logStat = await statOrNull(status.logFile);
  const simWorkDir = status.meta?.workDirName ? path.join(status.jobDir, status.meta.workDirName) : null;
  return {
    ...status,
    ok,
    kind: status.kind || 'sim',
    testbench: status.meta?.testbench || null,
    sim: {
      ...sim,
      passCount: sim.passCount,
      errorCount: sim.errorCount,
      failCount: sim.failCount,
      passLabels: sim.passLabels,
      errorLabels: sim.errorLabels,
      finished: sim.finished,
    },
    failures: dedupeFailures(failures),
    evidence: {
      logFile: status.logFile,
      logSize: logStat ? logStat.size : 0,
      logSizeHuman: humanBytes(logStat ? logStat.size : 0),
      jobDir: status.jobDir,
      workDir: simWorkDir,
      reportDir: null,
    },
    summary: ok
      ? `仿真通过：${sim.passCount} 个 [PASS]，0 个 Error（耗时 ${Math.round((status.elapsedMs || 0) / 1000)}s）`
      : `仿真未通过：${sim.passCount} 个 [PASS]，${sim.errorCount} 个 Error${sim.errorLabels.length ? `（${sim.errorLabels.slice(0, 6).join('；')}）` : ''}`,
  };
}

/** 启动 + 等待 + 判定（CLI / 测试复用） */
export async function runSimJob({ projectDir, testbench = null, timeoutSec = SIM_TIMEOUT_DEFAULT_SEC, waitTimeoutSec = 600, env = process.env, cwd = process.cwd() } = {}) {
  const started = await startSimJob({ projectDir, testbench, timeoutSec, env, cwd });
  const waited = await waitJob({
    projectDir: started.ctx.projectDir,
    jobId: started.job.id,
    timeoutMs: Math.max(5, waitTimeoutSec) * 1000,
    env,
    cwd,
  });
  const evaluated = await evaluateSimJob(waited);
  return { ...started, waited, evaluated };
}
