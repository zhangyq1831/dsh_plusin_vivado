#!/usr/bin/env node
// Vivado MCP 工具链 CLI（人/Agent 兜底）：与 MCP 工具共用 core 实现。
// 用法见 --help。退出码：0 成功；1 工具/环境错误；2 参数错误；3 job 失败。
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBuildJob, startBuildJob } from '../src/core/build.mjs';
import { runDoctor } from '../src/core/doctor.mjs';
import { McpError, toMcpError } from '../src/core/errors.mjs';
import { evaluateHwJob, runDebugCores, runHwProgram, runHwScan } from '../src/core/hw.mjs';
import { cancelJob, getJobOutput, getJobStatus, listJobs, waitJob } from '../src/core/jobs.mjs';
import { formatDurationMs, humanBytes } from '../src/core/util.mjs';
import { getProjectInfo, listTestbenches } from '../src/core/project.mjs';
import { collectReports } from '../src/core/reports.mjs';
import { evaluateSimJob, runSimJob, startSimJob } from '../src/core/sim.mjs';
import {
  renderDebugCores,
  renderDoctor,
  renderHwProgram,
  renderHwScan,
  renderJob,
  renderJobList,
  renderProjectInfo,
  renderReports,
  renderTestbenches,
} from '../src/mcp/tools.mjs';

const EXIT = { OK: 0, TOOL_ERROR: 1, ARG_ERROR: 2, JOB_FAILED: 3 };

// 同步写 stdout/stderr：Windows 管道/重定向下保证输出完整落盘，且对端提前关闭（EPIPE）时
// 不抛未捕获异常，退出码保持 0/1/2/3 语义。
function writeStdout(text) {
  try {
    fs.writeSync(1, String(text));
  } catch {
    /* ignore EPIPE */
  }
}
function writeStderr(text) {
  try {
    fs.writeSync(2, String(text));
  } catch {
    /* ignore EPIPE */
  }
}
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const USAGE = `Vivado MCP 工具链 CLI

用法：
  node tools/vivado-mcp/bin/vivado-cli.mjs <command> [options]

命令：
  doctor                 环境体检（Vivado/工程/GUI 锁/可写性/TCL 就绪度）
  info                   工程信息（解析 xpr，不启动 Vivado）
  tbs                    列出 testbench 及依赖情况
  sim                    启动并等待一次仿真（默认当前 sim top）
  synth | impl | bitstream | build
                         启动并等待构建（stage=synth/impl/bitstream/full）
  status <job_id>        查询 job 状态与判定
  wait <job_id>          等待 job 结束（--timeout 控制等待秒数）
  output <job_id>        打印 job 日志尾部
  cancel <job_id>        取消 job（杀进程树）
  jobs                   列出最近 jobs
  reports                解析最新报告（或 --job <job_id> 指定）
  hw-scan                扫描 JTAG 硬件（只读；本地 hw_server 不可达时自动启动）
  hw-program             烧写显式指定的 bit 到 JTAG 设备（写操作，需 --bit）
  debug-cores            分析 dcp 中的 ILA/VIO（只读，不打开工程）

options：
  --project DIR          工程根目录或 .xpr 路径（默认 env VIVADO_PROJECT_ROOT）
  --tb NAME              仿真 testbench（module 或文件名，默认 sim_1 top）
  --top NAME             覆盖 design top（构建）
  --run NAME             覆盖实现 run
  --synth-run NAME       覆盖综合 run
  --impl-run NAME        覆盖实现 run（同 --run）
  --jobs N               launch_runs 并行度（默认 4）
  --extra-xdc PATH       可选：额外 .xdc 约束（绝对路径），仅构建冒烟用；
                         运行期注入内存工程，不修改/保存工程文件
  --bit PATH             hw-program 要烧写的 .bit 绝对路径（必填，不会自动选最新 bit）
  --device NAME          hw-program 目标设备（设备索引或 PART 片段）
  --no-verify            hw-program 跳过烧写后校验
  --hw-server URL        hw_server 地址（默认 localhost:3121）
  --dcp PATH             debug-cores 要分析的 .dcp 绝对路径（默认从 current impl run 推导）
  --include-nets         debug-cores 端口信息包含 net 名
  --timeout SEC          本命令等待上限（sim 默认 1800；构建默认 3600；wait 默认 240；hw-scan 默认 120；hw-program 默认 180；debug-cores 默认 240）
  --lines N              output 行数（默认 80，上限 400）
  --limit N              jobs 条数（默认 10）
  --job ID               指定 job（reports/status 等）
  --no-wait              启动类命令只启动、不等待
  --no-version           doctor 跳过 vivado -version 探测
  --json                 输出 JSON（可解析）
  -h, --help             显示本帮助
  -v, --version          版本

退出码：0 成功；1 工具/环境错误；2 参数错误；3 job 失败。
`;

class ArgvError extends Error {}

/** 解析 argv：第一个非选项是 command，其余非选项是 positionals */
function parseArgv(argv) {
  const options = {};
  const positionals = [];
  const BOOLEAN_FLAGS = new Set(['json', 'no-wait', 'no-version', 'no-verify', 'include-nets', 'help', 'version']);
  const VALUE_OPTIONS = new Set([
    'project',
    'tb',
    'top',
    'run',
    'synth-run',
    'impl-run',
    'extra-xdc',
    'jobs',
    'timeout',
    'lines',
    'limit',
    'job',
    'bit',
    'device',
    'hw-server',
    'dcp',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('-')) {
      let name = token.replace(/^--?/, '');
      let value = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (name === 'h') name = 'help';
      if (name === 'v') name = 'version';
      if (BOOLEAN_FLAGS.has(name)) {
        if (value !== null) throw new ArgvError(`选项 --${name} 不接受值`);
        options[name] = true;
        continue;
      }
      if (!VALUE_OPTIONS.has(name)) throw new ArgvError(`未知选项：${token}`);
      if (value === null) {
        value = argv[++i];
        if (value === undefined) throw new ArgvError(`选项 --${name} 缺少值`);
      }
      options[name] = value;
      continue;
    }
    positionals.push(token);
  }
  // 数值类选项统一早校验，避免命令分支忽略后“静默接受非法值”
  for (const name of ['jobs', 'timeout', 'lines', 'limit']) {
    if (options[name] !== undefined && !Number.isFinite(Number(options[name]))) {
      throw new ArgvError(`--${name} 必须是数字，收到：${options[name]}`);
    }
  }
  return { command: positionals.shift() || null, positionals, options };
}

function parseIntOption(options, name, { min, max, def }) {
  if (options[name] === undefined) return def;
  const n = Number(options[name]);
  if (!Number.isFinite(n)) throw new ArgvError(`--${name} 必须是数字`);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getProjectDir(options) {
  return options.project || process.env.VIVADO_PROJECT_ROOT || undefined;
}

function output(value, options) {
  if (options.json) {
    writeStdout(JSON.stringify(value, null, 2) + '\n');
  }
}

function requireJobId(positionals, options) {
  const jobId = positionals[0] || options.job;
  if (!jobId) throw new ArgvError('缺少 job_id（例如：status <job_id> 或 --job <job_id>）');
  return jobId;
}

async function evalJob(status) {
  if (status.kind === 'sim') return await evaluateSimJob(status);
  if (status.kind === 'build') return await evaluateBuildJob(status);
  if (status.kind === 'hw' || status.kind === 'debug') return await evaluateHwJob(status);
  return { ...status, ok: status.status === 'done' };
}

async function main() {
  const { command, positionals, options } = parseArgv(process.argv.slice(2));

  if (options.help || command === 'help' || command === null) {
    writeStdout(USAGE);
    return options.help || command === 'help' ? EXIT.OK : EXIT.ARG_ERROR;
  }
  if (options.version) {
    writeStdout(`@local/vivado-mcp 0.1.0\n`);
    return EXIT.OK;
  }

  const projectDir = getProjectDir(options);
  const json = !!options.json;
  const env = process.env;
  const cwd = process.cwd();

  switch (command) {
    case 'doctor': {
      const report = await runDoctor({ projectDir, includeVersion: !options['no-version'], env, cwd });
      if (json) output(report, options);
      else writeStdout(renderDoctor(report) + '\n');
      return report.ok ? EXIT.OK : EXIT.TOOL_ERROR;
    }
    case 'info': {
      const info = await getProjectInfo({ projectDir, env, cwd });
      if (json) output(info, options);
      else writeStdout(renderProjectInfo(info) + '\n');
      return EXIT.OK;
    }
    case 'tbs': {
      const report = await listTestbenches({ projectDir, env, cwd });
      if (json) output(report, options);
      else writeStdout(renderTestbenches(report) + '\n');
      return EXIT.OK;
    }
    case 'sim': {
      const tb = options.tb;
      const waitSec = parseIntOption(options, 'timeout', { min: 5, max: 7200, def: 1800 });
      if (options['no-wait']) {
        const started = await startSimJob({ projectDir, testbench: tb, env, cwd });
        if (json) output({ ok: true, job_id: started.job.id, testbench: started.testbench.module, workDir: started.workDir, logFile: started.job.logFile }, options);
        else writeStdout(`已启动仿真 job：${started.job.id}（testbench=${started.testbench.module}）\n用 status/wait 查询。\n`);
        return EXIT.OK;
      }
      const result = await runSimJob({ projectDir, testbench: tb, waitTimeoutSec: waitSec, env, cwd });
      const e = result.evaluated;
      if (json) output(e, options);
      else {
        writeStdout(`仿真 job：${e.id}（testbench=${e.testbench || tb}）\n`);
        writeStdout(renderJob(e) + '\n');
      }
      return e.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'synth':
    case 'impl':
    case 'bitstream':
    case 'build': {
      const stage = command === 'build' ? 'full' : command;
      const waitSec = parseIntOption(options, 'timeout', { min: 5, max: 28800, def: 3600 });
      const jobs = parseIntOption(options, 'jobs', { min: 1, max: 32, def: 4 });
      const started = await startBuildJob({
        projectDir,
        stage,
        top: options.top,
        run: options.run,
        synthRun: options['synth-run'],
        implRun: options['impl-run'],
        jobs,
        extraXdc: options['extra-xdc'] || null,
        env,
        cwd,
      });
      if (options['no-wait']) {
        if (json) output({ ok: true, job_id: started.job.id, stage, backup: started.backup, reportDir: started.reportDir, logFile: started.job.logFile }, options);
        else
          writeStdout(
            `已启动构建 job：${started.job.id}（stage=${stage}）\nxpr 备份：${started.backup.backupPath}\n报告目录：${started.reportDir}\n用 status/wait 查询。\n`,
          );
        return EXIT.OK;
      }
      const waited = await waitJob({ projectDir: started.ctx.projectDir, jobId: started.job.id, timeoutMs: waitSec * 1000, env, cwd });
      const e = await evaluateBuildJob(waited);
      if (json) output(e, options);
      else {
        writeStdout(`构建 job：${e.id}（stage=${stage}）\n`);
        if (e.timedOut) writeStdout(`等待超时（${waitSec}s），job 仍在运行，可稍后 status/wait。\n`);
        writeStdout(renderJob(e) + '\n');
      }
      if (e.timedOut && (e.status === 'running' || e.status === 'starting')) return EXIT.OK;
      return e.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'status': {
      const jobId = requireJobId(positionals, options);
      const status = await getJobStatus({ projectDir, jobId, env, cwd });
      const running = status.status === 'running' || status.status === 'starting';
      const e = running ? status : await evalJob(status);
      if (json) output(e, options);
      else writeStdout(renderJob(e) + '\n');
      if (running) return EXIT.OK;
      return e.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'wait': {
      const jobId = requireJobId(positionals, options);
      const waitSec = parseIntOption(options, 'timeout', { min: 1, max: 240, def: 240 });
      const waited = await waitJob({ projectDir, jobId, timeoutMs: waitSec * 1000, env, cwd });
      const running = waited.status === 'running' || waited.status === 'starting';
      const e = running ? waited : await evalJob(waited);
      if (json) output(e, options);
      else {
        if (e.timedOut && running) {
          writeStdout(`等待超时（${waitSec}s），job 仍在运行（进度 ${e.progress?.percent ?? '未知'}%）。\n`);
        }
        writeStdout(renderJob(e) + '\n');
      }
      if (running) return EXIT.OK;
      return e.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'output': {
      const jobId = requireJobId(positionals, options);
      const lines = parseIntOption(options, 'lines', { min: 1, max: 400, def: 80 });
      const out = await getJobOutput({ projectDir, jobId, lines, env, cwd });
      if (json) output(out, options);
      else {
        writeStdout(`job ${out.id} 日志尾部（${out.lines.length} 行 / 文件 ${out.logSizeHuman}）\nlog: ${out.logFile}\n----\n`);
        writeStdout(out.lines.join('\n') + '\n');
      }
      return EXIT.OK;
    }
    case 'cancel': {
      const jobId = requireJobId(positionals, options);
      const result = await cancelJob({ projectDir, jobId, env, cwd });
      const e = await evalJob(result.status);
      if (json) output({ ...result, status: e }, options);
      else writeStdout((result.alreadyTerminal ? `job ${e.id} 已是终态（${e.status}），无需取消。\n` : result.cancelled ? `已取消 job ${e.id}。\n` : `已发出取消，但仍有存活进程：${result.stillAlive.join(', ')}\n`) + renderJob(e) + '\n');
      if (result.alreadyTerminal) return e.status === 'done' ? EXIT.OK : EXIT.JOB_FAILED;
      return result.cancelled ? EXIT.OK : EXIT.TOOL_ERROR;
    }
    case 'jobs': {
      const limit = parseIntOption(options, 'limit', { min: 1, max: 50, def: 10 });
      const list = await listJobs({ projectDir, limit, env, cwd });
      if (json) output(list, options);
      else writeStdout(renderJobList(list) + '\n');
      return EXIT.OK;
    }
    case 'reports': {
      const jobId = positionals[0] || options.job || null;
      const report = await collectReports({ projectDir, jobId, env, cwd });
      if (json) output(report, options);
      else writeStdout(renderReports(report) + '\n');
      return EXIT.OK;
    }
    case 'hw-scan': {
      const timeoutSec = parseIntOption(options, 'timeout', { min: 30, max: 300, def: 120 });
      const result = await runHwScan({
        projectDir,
        hwServerUrl: options['hw-server'] || 'localhost:3121',
        timeoutSec,
        env,
        cwd,
      });
      if (json) output(result, options);
      else writeStdout(renderHwScan(result) + '\n');
      return result.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'hw-program': {
      const bitFile = options.bit;
      if (!bitFile) throw new ArgvError('缺少 --bit <绝对路径>（hw-program 不会自动选择最新 bit）');
      const timeoutSec = parseIntOption(options, 'timeout', { min: 60, max: 300, def: 180 });
      const result = await runHwProgram({
        bitFile,
        device: options.device || null,
        verify: options['no-verify'] !== true,
        projectDir,
        hwServerUrl: options['hw-server'] || 'localhost:3121',
        timeoutSec,
        env,
        cwd,
      });
      if (json) output(result, options);
      else writeStdout(renderHwProgram(result) + '\n');
      return result.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    case 'debug-cores': {
      const result = await runDebugCores({
        projectDir,
        dcpFile: options.dcp || null,
        includeNets: options['include-nets'] === true,
        env,
        cwd,
      });
      if (json) output(result, options);
      else writeStdout(renderDebugCores(result) + '\n');
      return result.ok ? EXIT.OK : EXIT.JOB_FAILED;
    }
    default:
      throw new ArgvError(`未知命令：${command}（用 --help 查看用法）`);
  }
}

main()
  .then((code) => {
    // 用 exitCode（而不是 process.exit）让 Node 在 stdout 全部 flush 后再退出，
    // 避免 Windows 管道下 JSON 输出被截断、退出码异常。
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof ArgvError) {
      writeStderr(`参数错误：${err.message}\n\n${USAGE}`);
      process.exitCode = EXIT.ARG_ERROR;
      return;
    }
    const mcpErr = err instanceof McpError ? err : toMcpError(err);
    const payload = {
      ok: false,
      error: { code: mcpErr.code || 'CLI_ERROR', message: mcpErr.message, hint: mcpErr.hint || '', kind: mcpErr.kind || 'internal' },
    };
    const wantJson = process.argv.includes('--json');
    if (wantJson) writeStdout(JSON.stringify(payload, null, 2) + '\n');
    else {
      writeStderr(`错误：${mcpErr.message}\n`);
      if (mcpErr.hint) writeStderr(`修复建议：${mcpErr.hint}\n`);
    }
    process.exitCode = mcpErr.kind === 'invalid_params' ? EXIT.ARG_ERROR : EXIT.TOOL_ERROR;
  });
