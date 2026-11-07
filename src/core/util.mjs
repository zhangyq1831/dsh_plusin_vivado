// 零依赖通用工具：文件读写、原子写、子进程、进程树、路径处理等。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/** 毫秒等待 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ISO 时间（YYYY-MM-DDTHH:mm:ss.sssZ） */
export function isoNow(date = new Date()) {
  return date.toISOString();
}

/** 文件名安全 UTC 时间戳（YYYYMMDDTHHMMSSZ） */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 随机 hex（默认 6 位） */
export function randomHex(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** 计算文本 sha256（前 16 位） */
export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function pathExistsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export function statOrNullSync(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function readTextFile(p, encoding = 'utf8') {
  return await fsp.readFile(p, encoding);
}

export async function readTextFileOrNull(p, encoding = 'utf8') {
  try {
    return await fsp.readFile(p, encoding);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

export function readTextFileOrNullSync(p, encoding = 'utf8') {
  try {
    return fs.readFileSync(p, encoding);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

export async function readJsonFile(p, fallback = null) {
  const text = await readTextFileOrNull(p);
  if (text === null || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 原子写文件：先写同目录临时文件再 rename（Windows 上 rename 会覆盖已存在文件） */
export async function writeFileAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomHex()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, filePath);
  return filePath;
}

export async function writeJsonAtomic(filePath, obj) {
  return await writeFileAtomic(filePath, JSON.stringify(obj, null, 2) + '\n');
}

/** 读取文件末尾最多 maxBytes，避免大日志拖垮内存 */
export async function readTail(filePath, maxBytes = 256 * 1024) {
  let handle;
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '';
    handle = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString('utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** 取文本最后 n 行 */
export function tailLines(text, n = 80) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - n));
}

export function truncateText(text, maxLen = 4000) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}\n...（已截断，原长度 ${s.length} 字符）`;
}

/** 判断 pid 是否存活（Windows 下 process.kill(pid, 0) 可用） */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/** Windows 参数转义：仅处理空白/引号，参数由本工具链自己生成，不含内嵌双引号 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** 构造 Windows 命令行："exe" arg1 "arg 2" */
export function toWindowsCommandLine(exePath, args = []) {
  return [quoteWindowsArg(exePath), ...args.map(quoteWindowsArg)].join(' ');
}

/**
 * 把可执行文件 + 参数转换成 spawn 所需的 {file, args, windowsVerbatimArguments}。
 * Windows 上 .bat/.cmd 必须经 cmd.exe 启动，且用 /d /s /c + 外层引号，避免 arguments 被截断。
 */
export function executableInvocation(exePath, args = []) {
  if (!exePath) throw new Error('executableInvocation: exePath 为空');
  if (isWindows && /\.(bat|cmd)$/i.test(exePath)) {
    const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const cmdLine = toWindowsCommandLine(exePath, args);
    return { file: comspec, args: ['/d', '/s', '/c', `"${cmdLine}"`], windowsVerbatimArguments: true };
  }
  return { file: exePath, args: Array.isArray(args) ? args : [] };
}

/** 杀进程树（Windows: taskkill /T /F；其它平台: kill(-pid)） */
export async function killProcessTree(pid, { waitMs = 4000 } = {}) {
  const n = Number(pid);
  if (!isProcessAlive(n)) return { killed: false, reason: 'not-alive', pid: n };
  if (isWindows) {
    const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const res = await runProcess({
      file: comspec,
      args: ['/d', '/s', '/c', `taskkill /PID ${n} /T /F`],
      timeoutMs: 10000,
    });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && isProcessAlive(n)) await sleep(80);
    return {
      killed: !isProcessAlive(n),
      pid: n,
      stdout: res.stdout,
      stderr: res.stderr,
      code: res.code,
    };
  }
  try {
    process.kill(-n, 'SIGKILL');
  } catch {
    try {
      process.kill(n, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && isProcessAlive(n)) await sleep(80);
  return { killed: !isProcessAlive(n), pid: n };
}

/**
 * 运行一个短命令并捕获输出（适合 tasklist / vivado -version / 工具探测）。
 * 返回 {code, signal, stdout, stderr, timedOut, error, elapsedMs}
 */
export function runProcess({
  file,
  args = [],
  cwd,
  env,
  timeoutMs = 120000,
  maxOutputBytes = 4 * 1024 * 1024,
  input = null,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const inv = executableInvocation(file, args);
    let child;
    try {
      child = spawn(inv.file, inv.args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        windowsVerbatimArguments: !!inv.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: String(err && err.message ? err.message : err),
        elapsedMs: Date.now() - started,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid, { waitMs: 2000 }).catch(() => {});
      child.kill('SIGKILL');
    }, Math.max(1000, timeoutMs));
    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      return next.length > maxOutputBytes ? next.slice(-maxOutputBytes) : next;
    };
    child.stdout.on('data', (d) => {
      stdout = append(stdout, d);
    });
    child.stderr.on('data', (d) => {
      stderr = append(stderr, d);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr + (err && err.message ? `\n${err.message}` : ''),
        timedOut,
        error: String(err && err.message ? err.message : err),
        elapsedMs: Date.now() - started,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null, elapsedMs: Date.now() - started });
    });
    if (input != null) {
      try {
        child.stdin.end(input);
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
  });
}

/** 人类可读耗时 */
export function formatDurationMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m${rest}s`;
}

/** 人性化字节数 */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)}${units[i]}`;
}

/** 展开 ~ 开头的路径 */
export function expandUserPath(p) {
  if (!p) return p;
  const s = String(p).trim();
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 安全 JSON.parse */
export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 按字段去重 */
export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 绝对化并规范化路径（不要求存在） */
export function resolvePath(p, base = process.cwd()) {
  if (!p) return p;
  return path.resolve(base, expandUserPath(String(p)));
}

/** 确保某文件路径的父目录存在 */
export async function ensureParentDir(filePath) {
  return await ensureDir(path.dirname(filePath));
}

/** 列出目录（不存在时返回空数组） */
export async function listDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
}
