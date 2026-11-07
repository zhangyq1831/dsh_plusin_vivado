// 环境与工程解析：VIVADO_BIN / VIVADO_PROJECT_ROOT / 工程根与 xpr 发现、目录约定。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envError } from './errors.mjs';
import { expandUserPath, listDirSafe, pathExists } from './util.mjs';

/** 本包根目录（tools/vivado-mcp） */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 运行期产物的根目录名（相对工程根） */
export const RUNTIME_DIR_NAME = '.vivado-mcp';
export const JOBS_DIR_NAME = 'jobs';
export const REPORTS_DIR_NAME = 'reports';
export const BACKUP_DIR_NAME = 'backup';
export const VERSION_CACHE_NAME = 'version-cache.json';

/** 已知环境变量名 */
export const ENV = Object.freeze({
  projectRoot: 'VIVADO_PROJECT_ROOT',
  vivadoBin: 'VIVADO_BIN',
  tclDir: 'VIVADO_MCP_TCL_DIR',
  nodeBin: 'VIVADO_MCP_NODE',
});

/** 默认 Vivado 安装路径候选（按 SPEC §4.4） */
export const VIVADO_PATH_CANDIDATES = [
  'D:\\Xilinx\\Vivado\\2018.3\\bin\\vivado.bat',
  'C:\\Xilinx\\Vivado\\2018.3\\bin\\vivado.bat',
];

/** 工程上下文：所有派生目录约定集中在这里 */
export function createProjectContext(projectDir, xprPath) {
  const resolvedProjectDir = path.resolve(projectDir);
  const resolvedXpr = xprPath ? path.resolve(xprPath) : null;
  const xprBase = resolvedXpr ? path.basename(resolvedXpr, '.xpr') : path.basename(resolvedProjectDir);
  const runtimeDir = path.join(resolvedProjectDir, RUNTIME_DIR_NAME);
  return {
    projectDir: resolvedProjectDir,
    xprPath: resolvedXpr,
    xprBase,
    xprName: resolvedXpr ? path.basename(resolvedXpr) : null,
    srcsDir: path.join(resolvedProjectDir, `${xprBase}.srcs`),
    runsDir: path.join(resolvedProjectDir, `${xprBase}.runs`),
    cacheDir: path.join(resolvedProjectDir, `${xprBase}.cache`),
    ipUserFilesDir: path.join(resolvedProjectDir, `${xprBase}.ip_user_files`),
    simDir: path.join(resolvedProjectDir, `${xprBase}.sim`),
    runtimeDir,
    jobsDir: path.join(runtimeDir, JOBS_DIR_NAME),
    reportsDir: path.join(runtimeDir, REPORTS_DIR_NAME),
    backupDir: path.join(runtimeDir, BACKUP_DIR_NAME),
    versionCachePath: path.join(runtimeDir, VERSION_CACHE_NAME),
  };
}

/** 在目录里找 *.xpr；返回 {projectDir, xprPath, candidates} 或 null */
export async function findXprInDir(dir) {
  const entries = await listDirSafe(dir);
  const candidates = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xpr'))
    .map((e) => path.join(dir, e.name))
    .sort();
  if (candidates.length === 0) return null;
  return { projectDir: dir, xprPath: candidates[0], candidates };
}

/**
 * 解析工程根：
 *   1) 显式 project_dir（目录或 .xpr 路径）
 *   2) env VIVADO_PROJECT_ROOT
 *   3) 从 cwd 逐级向上找“唯一 *.xpr”
 * @returns {Promise<{projectDir:string, xprPath:string|null, source:'param'|'env'|'cwd-search'}>}
 */
export async function resolveProject({
  projectDir,
  env = process.env,
  cwd = process.cwd(),
  requireXpr = true,
} = {}) {
  const fromParam = projectDir ? expandUserPath(String(projectDir)) : '';
  const fromEnv = env[ENV.projectRoot] ? expandUserPath(String(env[ENV.projectRoot])) : '';
  const explicit = fromParam || fromEnv;
  const source = fromParam ? 'param' : fromEnv ? 'env' : 'cwd-search';

  if (explicit) {
    const abs = path.resolve(cwd, explicit);
    // 允许直接传 .xpr
    if (path.extname(abs).toLowerCase() === '.xpr') {
      if (!(await pathExists(abs))) {
        throw envError(`指定的工程文件不存在：${abs}`, `检查 --project 参数或 ${ENV.projectRoot} 环境变量。`);
      }
      return { projectDir: path.dirname(abs), xprPath: abs, source };
    }
    if (!(await pathExists(abs))) {
      throw envError(`工程目录不存在：${abs}`, `检查 --project 参数或 ${ENV.projectRoot} 环境变量是否指向 Vivado 工程根目录。`);
    }
    const found = await findXprInDir(abs);
    if (!found) {
      if (!requireXpr) return { projectDir: abs, xprPath: null, source };
      throw envError(
        `目录中没有找到 *.xpr 工程文件：${abs}`,
        `请指向包含 .xpr 的 Vivado 工程根目录，或设置 ${ENV.projectRoot}。`,
      );
    }
    if (found.candidates.length > 1) {
      throw envError(
        `目录中存在多个 *.xpr，无法自动选择：${found.candidates.map((p) => path.basename(p)).join(', ')}`,
        `请把工程根指向只含一个 .xpr 的目录，或直接传 .xpr 文件路径。`,
      );
    }
    return { projectDir: abs, xprPath: found.xprPath, source };
  }

  // 从 cwd 向上找
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth++) {
    const found = await findXprInDir(dir);
    if (found) {
      if (found.candidates.length > 1) {
        throw envError(
          `目录中存在多个 *.xpr，无法自动选择：${found.candidates.map((p) => path.basename(p)).join(', ')}`,
          `请设置 ${ENV.projectRoot} 指向唯一工程目录。`,
        );
      }
      return { projectDir: dir, xprPath: found.xprPath, source: 'cwd-search' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw envError(
    `未找到 Vivado 工程：当前目录 ${path.resolve(cwd)} 及上级目录都没有 *.xpr`,
    `请在工程根目录运行，或设置环境变量 ${ENV.projectRoot}=<工程根绝对路径>，或传 project_dir 参数。`,
  );
}

/** TCL 脚本目录：默认包内 tcl/，可用 VIVADO_MCP_TCL_DIR 覆盖（测试/T1 联调用） */
export function resolveTclDir(env = process.env) {
  const override = env[ENV.tclDir];
  if (override && String(override).trim()) return path.resolve(expandUserPath(String(override)));
  return path.join(PACKAGE_ROOT, 'tcl');
}

/** 本机 node 可执行文件（用于 detached job runner）：优先 env 覆盖，其次当前进程 */
export function resolveNodeBin(env = process.env) {
  const override = env[ENV.nodeBin];
  if (override && String(override).trim()) return path.resolve(expandUserPath(String(override)));
  return process.execPath;
}
