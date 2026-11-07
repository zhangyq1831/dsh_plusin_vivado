// 后台 job 执行器：由 MCP server 以 detached 方式启动，进程脱离 server 生命周期。
// 职责：按 job.json 里的 steps 顺序执行命令、把 stdout/stderr 合并写入 run.log、
// 把实时/终态写进 runner.json（server 只读）、超时杀进程树、结束后按需恢复 xpr。
// 本文件必须零 npm 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ensureDir,
  executableInvocation,
  formatDurationMs,
  isoNow,
  killProcessTree,
  pathExists,
  readJsonFile,
  writeJsonAtomic,
} from './core/util.mjs';

const jobDir = process.argv[2];
if (!jobDir) {
  process.stderr.write('[job-runner] 缺少 job 目录参数\n');
  process.exit(2);
}
const JOB_JSON = path.join(jobDir, 'job.json');
const RUNNER_JSON = path.join(jobDir, 'runner.json');

const state = {
  runnerPid: process.pid,
  status: 'starting',
  startedAt: isoNow(),
  endedAt: null,
  exitCode: null,
  timedOut: false,
  childPid: null,
  currentStep: null,
  steps: [],
  error: null,
  xprRestored: null,
};

let job = null;
let logStream = null;
let currentChild = null;
let timedOut = false;
let finalized = false;

function writeLog(text) {
  if (!logStream) return;
  try {
    logStream.write(text);
  } catch {
    /* ignore */
  }
}

async function persist() {
  await writeJsonAtomic(RUNNER_JSON, state).catch(() => {});
}

async function finalize({ status, exitCode, error = null }) {
  if (finalized) return;
  finalized = true;
  state.status = status;
  state.exitCode = exitCode;
  state.endedAt = isoNow();
  if (error) state.error = error;
  if (timedOut) state.timedOut = true;

  // 按需恢复 xpr（备份/恢复约定见 SPEC §2.4、§7）
  if (job && job.restoreXpr && job.restoreXpr.backupPath && job.restoreXpr.xprPath) {
    try {
      if (await pathExists(job.restoreXpr.backupPath)) {
        await fs.promises.copyFile(job.restoreXpr.backupPath, job.restoreXpr.xprPath);
        state.xprRestored = { restoredAt: isoNow(), from: job.restoreXpr.backupPath, to: job.restoreXpr.xprPath };
        writeLog(`[runner] 已从备份恢复 xpr: ${job.restoreXpr.backupPath} -> ${job.restoreXpr.xprPath}\n`);
      } else {
        state.xprRestored = { error: `备份文件不存在：${job.restoreXpr.backupPath}` };
        writeLog(`[runner] 警告：xpr 备份不存在，未恢复：${job.restoreXpr.backupPath}\n`);
      }
    } catch (err) {
      state.xprRestored = { error: String(err && err.message ? err.message : err) };
      writeLog(`[runner] 警告：恢复 xpr 失败：${state.xprRestored.error}\n`);
    }
  }

  await persist();
  writeLog(`[runner] job 结束：status=${state.status} exitCode=${state.exitCode} 耗时=${formatDurationMs(Date.now() - Date.parse(state.startedAt))}\n`);
  try {
    logStream.end();
  } catch {
    /* ignore */
  }
}

async function killCurrentChild(reason) {
  const child = currentChild;
  if (!child || !child.pid) return;
  writeLog(`[runner] ${reason}，终止进程树 pid=${child.pid}\n`);
  try {
    await killProcessTree(child.pid, { waitMs: 3000 });
  } catch (err) {
    writeLog(`[runner] kill 失败：${err && err.message ? err.message : err}\n`);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

async function handleSignal(signal) {
  if (finalized) return;
  writeLog(`[runner] 收到 ${signal}，取消 job\n`);
  await killCurrentChild(signal);
  await finalize({ status: 'cancelled', exitCode: null, error: `收到 ${signal}` });
  process.exit(0);
}
process.on('SIGINT', () => void handleSignal('SIGINT'));
process.on('SIGTERM', () => void handleSignal('SIGTERM'));

function runStep(step) {
  return new Promise((resolve) => {
    const invocation = executableInvocation(step.file, step.args || []);
    const env = { ...process.env, ...(job.env || {}), ...(step.env || {}) };
    let child;
    try {
      child = spawn(invocation.file, invocation.args || [], {
        cwd: step.cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: !!invocation.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      resolve({ code: null, signal: null, spawnError: String(err && err.message ? err.message : err) });
      return;
    }
    currentChild = child;
    state.childPid = child.pid || null;
    persist().catch(() => {});
    child.stdout.on('data', (chunk) => writeLog(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => writeLog(chunk.toString('utf8')));
    child.on('error', (err) => {
      currentChild = null;
      state.childPid = null;
      resolve({ code: null, signal: null, spawnError: String(err && err.message ? err.message : err) });
    });
    child.on('close', (code, signal) => {
      currentChild = null;
      state.childPid = null;
      resolve({ code: code === null ? (signal ? 1 : null) : code, signal: signal || null });
    });
  });
}

async function main() {
  job = await readJsonFile(JOB_JSON, null);
  if (!job) {
    process.stderr.write(`[job-runner] 无法读取 job.json：${JOB_JSON}\n`);
    process.exit(1);
  }
  await ensureDir(jobDir);
  await ensureDir(job.reportDir || path.join(jobDir, 'reports'));
  logStream = fs.createWriteStream(job.logFile, { flags: 'a' });
  await new Promise((resolve) => logStream.once('open', resolve));
  writeLog(`\n[runner] pid=${process.pid} job=${job.id} kind=${job.kind} stage=${job.stage} 开始于 ${state.startedAt}\n`);
  writeLog(`[runner] timeout_sec=${job.timeoutSec} project=${job.projectDir}\n`);
  await persist();

  const totalMs = Math.max(30, Number(job.timeoutSec) || 900) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    writeLog(`[runner] 超过 timeout_sec=${job.timeoutSec}，准备终止进程树\n`);
    void killCurrentChild('job 超时');
  }, totalMs);

  let exitCode = 0;
  let errorMessage = null;
  try {
    state.status = 'running';
    await persist();
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      if (timedOut) {
        exitCode = 124;
        errorMessage = 'job 超时';
        break;
      }
      state.currentStep = step.name;
      await ensureDir(step.cwd || jobDir);
      state.steps.push({ name: step.name, status: 'running', startedAt: isoNow(), endedAt: null, exitCode: null, elapsedMs: null });
      await persist();
      writeLog(`\n[runner] ===== step ${i + 1}/${job.steps.length}: ${step.name} =====\n`);
      writeLog(`[runner] cwd: ${step.cwd || jobDir}\n`);
      writeLog(`[runner] cmd: ${step.file} ${(step.args || []).join(' ')}\n`);
      const startedAt = Date.now();
      const result = await runStep(step);
      const record = state.steps[state.steps.length - 1];
      record.endedAt = isoNow();
      record.exitCode = result.code;
      record.elapsedMs = Date.now() - startedAt;
      record.status = result.code === 0 && !timedOut ? 'done' : 'failed';
      state.currentStep = null;
      await persist();
      if (timedOut) {
        exitCode = 124;
        errorMessage = 'job 超时';
        break;
      }
      if (result.spawnError) {
        exitCode = 1;
        errorMessage = `无法启动步骤 ${step.name}：${result.spawnError}`;
        writeLog(`[runner] ERROR：${errorMessage}\n`);
        break;
      }
      if (result.code !== 0) {
        exitCode = result.code === null ? 1 : result.code;
        errorMessage = `步骤 ${step.name} 退出码 ${exitCode}`;
        writeLog(`[runner] ERROR：${errorMessage}\n`);
        break;
      }
    }
  } catch (err) {
    exitCode = 1;
    errorMessage = `job runner 异常：${err && err.message ? err.message : err}`;
    writeLog(`[runner] 未捕获异常：${errorMessage}\n`);
  } finally {
    clearTimeout(timer);
  }

  let status = 'done';
  if (timedOut) status = 'failed';
  else if (exitCode !== 0) status = 'failed';
  await finalize({ status, exitCode, error: errorMessage });
  process.exit(0);
}

main().catch(async (err) => {
  try {
    writeLog(`[runner] 致命错误：${err && err.stack ? err.stack : err}\n`);
    await finalize({ status: 'failed', exitCode: 1, error: String(err && err.message ? err.message : err) });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
