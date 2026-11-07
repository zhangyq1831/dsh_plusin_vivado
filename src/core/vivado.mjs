// Vivado 环境发现与进程/锁检查：定位 vivado/xvlog/xelab/xsim、版本探测、GUI/工程锁。
import fs from 'node:fs';
import path from 'node:path';
import { ENV, VIVADO_PATH_CANDIDATES } from './config.mjs';
import { envError } from './errors.mjs';
import {
  isWindows,
  listDirSafe,
  pathExists,
  pathExistsSync,
  readJsonFile,
  readTextFileOrNull,
  runProcess,
  statOrNull,
  writeJsonAtomic,
} from './util.mjs';

const COMPANION_NAMES = {
  vivado: isWindows ? ['vivado.bat', 'vivado.exe'] : ['vivado'],
  xvlog: isWindows ? ['xvlog.bat', 'xvlog'] : ['xvlog'],
  xelab: isWindows ? ['xelab.bat', 'xelab'] : ['xelab'],
  xsim: isWindows ? ['xsim.bat', 'xsim'] : ['xsim'],
};

function candidateVivadoNames() {
  return isWindows ? ['vivado.bat', 'vivado.exe'] : ['vivado'];
}

/** VIVADO_BIN 可能给目录、.bat 或 .exe；归一化成实际存在的文件路径 */
async function normalizeVivadoBin(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const candidates = [];
  if (/\.(bat|exe)$/i.test(raw)) candidates.push(raw);
  else candidates.push(path.join(raw, 'vivado.bat'), path.join(raw, 'vivado.exe'), raw);
  for (const c of candidates) {
    if (await pathExists(c)) return path.resolve(c);
  }
  return null;
}

function* pathDirs(envPath) {
  const sep = path.delimiter;
  for (const dir of String(envPath || '').split(sep)) {
    if (dir && dir.trim()) yield dir.trim();
  }
}

/** 列出 Xilinx 安装根下的 vivado 版本目录（D:\Xilinx\Vivado\2018.3 之类） */
async function scanXilinxInstalls(roots) {
  const found = [];
  for (const root of roots) {
    const entries = await listDirSafe(root);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of candidateVivadoNames()) {
        const p = path.join(root, entry.name, 'bin', name);
        if (await pathExists(p)) found.push(p);
      }
    }
  }
  return found;
}

/** 依次搜索：VIVADO_BIN → 常见路径 → Xilinx 安装目录 → PATH；返回候选列表 */
export async function findVivadoCandidates({ env = process.env } = {}) {
  const tried = [];
  const results = [];
  const envValue = env[ENV.vivadoBin];
  if (envValue && String(envValue).trim()) {
    const normalized = await normalizeVivadoBin(envValue);
    tried.push({ source: 'env', value: envValue, found: normalized || null });
    if (normalized) return { results: [{ path: normalized, source: 'env' }], tried };
  } else {
    tried.push({ source: 'env', value: null, found: null });
  }

  for (const candidate of VIVADO_PATH_CANDIDATES) {
    const exists = await pathExists(candidate);
    tried.push({ source: 'common-path', value: candidate, found: exists ? candidate : null });
    if (exists) results.push({ path: path.resolve(candidate), source: 'common-path' });
  }
  if (results.length > 0) return { results, tried };

  const installRoots = ['D:\\Xilinx\\Vivado', 'C:\\Xilinx\\Vivado', '/opt/Xilinx/Vivado', '/tools/Xilinx/Vivado'];
  const scanned = await scanXilinxInstalls(installRoots);
  for (const p of scanned) {
    tried.push({ source: 'xilinx-install', value: p, found: p });
    results.push({ path: path.resolve(p), source: 'xilinx-install' });
  }
  if (results.length > 0) {
    // 优先高版本（2018.3 > 2017.4 等）
    results.sort((a, b) => String(b.path).localeCompare(String(a.path)));
    return { results, tried };
  }

  for (const dir of pathDirs(env.PATH || env.Path)) {
    for (const name of candidateVivadoNames()) {
      const p = path.join(dir, name);
      if (pathExistsSync(p)) {
        tried.push({ source: 'PATH', value: p, found: p });
        results.push({ path: path.resolve(p), source: 'PATH' });
      }
    }
  }
  return { results, tried };
}

/** 找到 vivado 同目录下的 xvlog/xelab/xsim */
export async function findCompanionTools(vivadoBin) {
  if (!vivadoBin) return null;
  const dir = path.dirname(vivadoBin);
  const out = {};
  for (const [tool, names] of Object.entries(COMPANION_NAMES)) {
    if (tool === 'vivado') continue;
    let found = null;
    for (const name of names) {
      const p = path.join(dir, name);
      if (await pathExists(p)) {
        found = p;
        break;
      }
    }
    out[tool] = found;
  }
  out.allPresent = !!(out.xvlog && out.xelab && out.xsim);
  out.missing = Object.entries(out)
    .filter(([k, v]) => k !== 'allPresent' && k !== 'missing' && !v)
    .map(([k]) => k);
  return out;
}

export function parseVivadoVersion(rawText) {
  const text = String(rawText || '');
  const m = /Vivado\s+v?(\d{4}\.\d+(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  const version = m[1];
  const sw = /SW Build\s+(\d+)\s+on\s+(.+)/i.exec(text);
  const ip = /IP Build\s+(\d+)\s+on\s+(.+)/i.exec(text);
  return {
    version,
    swBuild: sw ? { number: sw[1], date: sw[2].trim() } : null,
    ipBuild: ip ? { number: ip[1], date: ip[2].trim() } : null,
    raw: text.trim().slice(0, 1000),
  };
}

const versionCache = new Map(); // path -> {versionInfo, binMtimeMs, probedAt}

function cacheKey(p) {
  return path.resolve(p).toLowerCase();
}

async function readDiskVersionCache(cachePath) {
  const data = await readJsonFile(cachePath, null);
  if (!data || typeof data !== 'object' || !data.entries) return {};
  return data.entries;
}

/** 探测 `vivado.bat -version`（带内存+磁盘缓存，避免 MCP 每次调用都等启动） */
export async function probeVivadoVersion(vivadoBin, { env = process.env, cachePath = null, timeoutMs = 180000, force = false } = {}) {
  if (!vivadoBin) return { ok: false, version: null, error: '未找到 vivado 可执行文件' };
  const binStat = await statOrNull(vivadoBin);
  const binMtimeMs = binStat ? Math.round(binStat.mtimeMs) : 0;
  const key = cacheKey(vivadoBin);
  const mem = versionCache.get(key);
  if (!force && mem && mem.binMtimeMs === binMtimeMs && Date.now() - mem.probedAt < 24 * 3600 * 1000) {
    return { ok: true, ...mem.versionInfo, cached: true };
  }
  let disk = null;
  if (cachePath) {
    const entries = await readDiskVersionCache(cachePath);
    disk = entries[key] || null;
    if (!force && disk && disk.binMtimeMs === binMtimeMs && Date.now() - disk.probedAt < 7 * 24 * 3600 * 1000) {
      versionCache.set(key, { ...disk, cached: true });
      return { ok: true, ...disk.versionInfo, cached: true };
    }
  }
  const started = Date.now();
  const res = await runProcess({
    file: vivadoBin,
    args: ['-version'],
    env,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
  const versionInfo = parseVivadoVersion(combined);
  if (!versionInfo) {
    return {
      ok: false,
      version: null,
      error: `无法解析 vivado -version 输出（exit=${res.code}）`,
      raw: combined.trim().slice(0, 2000),
      elapsedMs,
    };
  }
  const entry = { versionInfo, binMtimeMs, probedAt: Date.now() };
  versionCache.set(key, entry);
  if (cachePath) {
    const entries = await readDiskVersionCache(cachePath);
    entries[key] = entry;
    await writeJsonAtomic(cachePath, { updatedAt: new Date().toISOString(), entries }).catch(() => {});
  }
  return { ok: true, ...versionInfo, elapsedMs, cached: false };
}

// ---------------------------------------------------------------------------
// GUI / 工程锁检查
// ---------------------------------------------------------------------------

/** 列出正在运行的 vivado.exe/vivado 进程（tasklist；失败返回空数组并带 error） */
export async function listVivadoProcesses() {
  if (!isWindows) {
    const res = await runProcess({ file: 'pgrep', args: ['-a', 'vivado'], timeoutMs: 5000 });
    if (res.code !== 0) return { processes: [], error: null };
    const processes = String(res.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const m = /^(\d+)\s+(.*)$/.exec(line);
        return m ? { pid: Number(m[1]), command: m[2] } : null;
      })
      .filter(Boolean);
    return { processes, error: null };
  }
  const res = await runProcess({
    file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
    args: ['/FI', 'IMAGENAME eq vivado.exe', '/FO', 'CSV', '/NH'],
    timeoutMs: 15000,
  });
  const text = String(res.stdout || '');
  if (/No tasks are running|没有运行的任务/i.test(text)) return { processes: [], error: null };
  const processes = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (!m) continue;
    if (!/^vivado(\.exe)?$/i.test(m[1])) continue;
    processes.push({ pid: Number(m[2]), image: m[1] });
  }
  return { processes, error: res.error || (res.code !== 0 && processes.length === 0 ? `tasklist exit=${res.code}` : null) };
}

/** 找工程区域的锁文件/临时会话目录 */
export async function findLockIndicators(projectDir) {
  const locks = [];
  const sessionDirs = [];
  const scan = async (dir, depth) => {
    if (!dir || depth < 0) return;
    const entries = await listDirSafe(dir);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.Xil') {
          const xilEntries = await listDirSafe(p);
          for (const x of xilEntries) {
            if (x.isDirectory()) sessionDirs.push(path.join(p, x.name));
          }
        } else if (depth > 0) {
          await scan(p, depth - 1);
        }
      } else if (/\.(lck|lock)$/i.test(entry.name)) {
        locks.push(p);
      }
    }
  };
  await scan(projectDir, 1);
  return { lockFiles: locks, sessionDirs, hasLock: locks.length > 0 };
}

/**
 * 构建前可用性检查。
 * @returns {{ok:boolean, blockers:Array<{code,message,hint}>, warnings:string[], processes:Array, lockFiles:string[]}}
 */
export async function checkProjectAvailability({ projectDir, allowExternalVivado = false, env = process.env } = {}) {
  const blockers = [];
  const warnings = [];
  const allowExternal = allowExternalVivado || env.VIVADO_MCP_ALLOW_EXTERNAL_VIVADO === '1';
  const { processes, error } = await listVivadoProcesses();
  if (error) warnings.push(`无法确认是否有 Vivado GUI 在运行：${error}`);
  const external = processes.filter((p) => !allowExternal);
  if (external.length > 0) {
    blockers.push({
      code: 'VIVADO_PROCESS_RUNNING',
      message: `检测到 ${external.length} 个 vivado.exe 进程（pid: ${external.map((p) => p.pid).join(', ')}），工程可能被 GUI 或其它 Vivado 实例占用`,
      hint: '先关闭 Vivado GUI / 等待其它批处理结束，再重试；确认无进程后可手动 taskkill。',
    });
  }
  const locks = await findLockIndicators(projectDir);
  if (locks.hasLock) {
    blockers.push({
      code: 'PROJECT_LOCKED',
      message: `检测到工程锁文件：${locks.lockFiles.map((p) => path.basename(p)).join(', ')}`,
      hint: '关闭占用工程的 Vivado 实例后删除残留 .lck 文件，再重试。',
    });
  }
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    processes,
    lockFiles: locks.lockFiles,
    sessionDirs: locks.sessionDirs,
    processCheckError: error,
  };
}

/** 要求环境可用，否则抛 McpError */
export async function requireVivado({ projectDir, env = process.env, cachePath = null, probeVersion = false, timeoutMs } = {}) {
  const found = await findVivadoCandidates({ env });
  if (found.results.length === 0) {
    throw envError(
      '未找到 Vivado（vivado.bat）',
      `设置环境变量 ${ENV.vivadoBin}=<Vivado bin 目录或 vivado.bat 绝对路径>，或把 Vivado bin 目录加入 PATH。已尝试：${found.tried
        .map((t) => `${t.source}:${t.value || '(未设置)'}`)
        .join('；')}`,
    );
  }
  const vivadoBin = found.results[0].path;
  const companions = await findCompanionTools(vivadoBin);
  let version = null;
  if (probeVersion) {
    const probed = await probeVivadoVersion(vivadoBin, { env, cachePath, timeoutMs });
    version = probed.ok ? probed : null;
  }
  return { vivadoBin, source: found.results[0].source, candidates: found.results, companions, version };
}

/** doctor 用的完整环境报告 */
export async function inspectVivadoEnvironment({ projectDir, env = process.env, cachePath = null, includeVersion = true, timeoutMs } = {}) {
  const found = await findVivadoCandidates({ env });
  const attempts = found.tried;
  if (found.results.length === 0) {
    return {
      ok: false,
      found: false,
      attempts,
      error: '未找到 Vivado',
      hint: `设置 ${ENV.vivadoBin}（例如 D:\\Xilinx\\Vivado\\2018.3\\bin\\vivado.bat）或把 bin 目录加入 PATH。`,
      envValues: { [ENV.vivadoBin]: env[ENV.vivadoBin] || null },
    };
  }
  const vivadoBin = found.results[0].path;
  const companions = await findCompanionTools(vivadoBin);
  let version = null;
  let versionError = null;
  if (includeVersion) {
    const probed = await probeVivadoVersion(vivadoBin, { env, cachePath, timeoutMs });
    if (probed.ok) version = probed;
    else versionError = probed.error;
  }
  const availability = projectDir ? await checkProjectAvailability({ projectDir }) : null;
  const binStat = await statOrNull(vivadoBin);
  return {
    ok: true,
    found: true,
    vivadoBin,
    source: found.results[0].source,
    vivadoStat: binStat ? { size: binStat.size, mtime: new Date(binStat.mtimeMs).toISOString() } : null,
    version,
    versionError,
    companions,
    candidates: found.results,
    attempts,
    availability,
    envValues: {
      [ENV.vivadoBin]: env[ENV.vivadoBin] || null,
      [ENV.projectRoot]: env[ENV.projectRoot] || null,
      [ENV.tclDir]: env[ENV.tclDir] || null,
    },
  };
}

/** 读取 vivado.log 的版本横幅（不启动进程） */
export async function readVivadoLogVersion(logPath) {
  const text = await readTextFileOrNull(logPath);
  if (!text) return null;
  const head = text.slice(0, 2000);
  return parseVivadoVersion(head);
}

/** 组装构建命令（vivado -mode batch ... -source xxx.tcl），供 build.mjs 使用 */
export function buildVivadoArgs({ tclPath, logPath }) {
  return ['-mode', 'batch', '-notrace', '-nojournal', '-log', logPath, '-source', tclPath];
}

/** 检查 tcl 脚本是否就绪 */
export async function inspectTclScripts(tclDir) {
  if (!tclDir) return { dir: null, scripts: [], complete: false };
  const required = ['synth.tcl', 'bitgen.tcl', 'build.tcl'];
  const optional = ['lib_flow.tcl'];
  const scripts = [];
  for (const name of [...required, ...optional]) {
    const p = path.join(tclDir, name);
    const stat = await statOrNull(p);
    scripts.push({ name, path: p, exists: !!stat, required: required.includes(name), size: stat ? stat.size : 0 });
  }
  const complete = scripts.filter((s) => s.required).every((s) => s.exists);
  return { dir: tclDir, scripts, complete, missing: scripts.filter((s) => s.required && !s.exists).map((s) => s.name) };
}

/** 检查目录可写（医生检查用）：创建删除一个临时文件 */
export async function checkWritable(dir) {
  const fsPromises = fs.promises;
  const testFile = path.join(dir, `.vivado-mcp-write-test-${process.pid}-${Date.now()}`);
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(testFile, 'ok');
    await fsPromises.unlink(testFile);
    return { writable: true, dir };
  } catch (err) {
    return { writable: false, dir, error: err && err.message ? err.message : String(err) };
  }
}
