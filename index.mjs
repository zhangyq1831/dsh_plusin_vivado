// Vivado toolchain — native DeepSeek Harness (DSH) Cordis Host plugin.
//
// Self-contained single package: this entry registers the 14 `vivado_*` tools
// (defined in ./src/mcp/tools.mjs) on ctx.tools and reuses the same core that the
// optional MCP stdio server (./src/server.mjs) and CLI expose.
//
// Why raw ToolDefinitions instead of defineTool:
//   profile plugins cannot resolve the harness-internal @deepseek-ai/* bare
//   specifiers, so this package imports no @deepseek-ai/* module. The tool
//   registry requires { name, description, parameters (lossless JSON Schema),
//   output: { schema, render }, execute }.
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listToolDefinitions, callTool } from './src/mcp/tools.mjs';

/** Cordis 插件名（Loader 日志用） */
export const name = 'vivado-plugin';
/** 依赖 tools 服务；apply 在注册工具前由 Loader 保证已就绪 */
export const inject = ['tools'];

/** Package root (the directory containing package.json). */
export const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** Known node installation fallbacks (used only when PATH has no node executable). */
export const KNOWN_NODE_PATHS = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
];
/** 单个工具调用的协作式超时预算（与 MCP 版 toolCallTimeoutMs=300000 对齐） */
export const TOOL_TIMEOUT_MS = 300000;

/** 文件存在且是普通文件 */
export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isNodeExecutableName(filePath) {
  return /^node(\.exe)?$/i.test(path.basename(String(filePath || '')));
}

/**
 * 解析“真正的 node 可执行文件”。
 *
 * DSH Host 进程常是桌面应用（Electron/打包 exe），process.execPath 不是 node；
 * 而 job runner 必须由 node 启动（core/jobs.mjs 用 process.env.VIVADO_MCP_NODE）。
 *
 * 优先级：config.nodeBin → env.VIVADO_MCP_NODE → process.execPath（仅 basename 为 node）
 *        → PATH 中 node.exe/node → 已知安装路径。
 * Windows 下只接受 .exe：.cmd/.bat 无法被 spawn 直接作为可执行文件启动。
 *
 * @returns {{path:string, source:string, diagnostics:Array<{source:string,value:string|null,exists:boolean}>}}
 */
export function resolveNodeBinary({
  configNodeBin = null,
  env = process.env,
  execPath = process.execPath,
  fileExists = isFile,
  pathEnv = env.PATH || env.Path || '',
  platform = process.platform,
} = {}) {
  const diagnostics = [];
  const consider = (source, value) => {
    if (!value) return null;
    const resolved = path.resolve(String(value));
    const exists = fileExists(resolved);
    diagnostics.push({ source, value: resolved, exists });
    return exists ? resolved : null;
  };

  // 1) 显式配置：给了但不存在 → 直接报错（不静默降级到别的 node）
  if (configNodeBin) {
    const found = consider('config.nodeBin', configNodeBin);
    if (!found) {
      throw new Error(
        `[vivado-plugin] config.nodeBin 指向的文件不存在：${path.resolve(String(configNodeBin))}。请把它改为本机 node.exe 绝对路径（例如 C:\\Program Files\\nodejs\\node.exe）。`,
      );
    }
    return { path: found, source: 'config.nodeBin', diagnostics };
  }

  // 2) 环境变量（同上：显式设置但无效 → 报错）
  if (env.VIVADO_MCP_NODE) {
    const found = consider('env.VIVADO_MCP_NODE', env.VIVADO_MCP_NODE);
    if (!found) {
      throw new Error(
        `[vivado-plugin] 环境变量 VIVADO_MCP_NODE 指向的文件不存在：${path.resolve(String(env.VIVADO_MCP_NODE))}。请修正该环境变量或在 bundle config 中配置 nodeBin。`,
      );
    }
    return { path: found, source: 'env.VIVADO_MCP_NODE', diagnostics };
  }

  // 3) Host 恰好就是 node 进程
  if (execPath && isNodeExecutableName(execPath)) {
    const found = consider('process.execPath', execPath);
    if (found) return { path: found, source: 'process.execPath', diagnostics };
  } else if (execPath) {
    diagnostics.push({ source: 'process.execPath', value: String(execPath), exists: true, skipped: 'basename 不是 node（Host 是桌面应用）' });
  }

  // 4) PATH 查找（Windows 只接受 node.exe）
  const names = platform === 'win32' ? ['node.exe'] : ['node'];
  const dirs = String(pathEnv || '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const exe of names) {
      const candidate = path.join(dir, exe);
      if (fileExists(candidate)) {
        diagnostics.push({ source: 'PATH', value: candidate, exists: true });
        return { path: candidate, source: 'PATH', diagnostics };
      }
    }
  }
  diagnostics.push({ source: 'PATH', value: null, exists: false });

  // 5) 已知安装路径兜底
  for (const known of KNOWN_NODE_PATHS) {
    if (fileExists(known)) {
      diagnostics.push({ source: 'known-path', value: known, exists: true });
      return { path: path.resolve(known), source: 'known-path', diagnostics };
    }
  }

  throw new Error(
    `[vivado-plugin] 未找到可用的 node 可执行文件（job runner 需要真实 node，不能是 Host 的桌面进程）。` +
      `已尝试：config.nodeBin、env VIVADO_MCP_NODE、process.execPath(${execPath || '未知'})、PATH、${KNOWN_NODE_PATHS.join(' / ')}。` +
      `请安装 Node.js 或在 bundle config 中设置 nodeBin（例如 C:\\Program Files\\nodejs\\node.exe）。`,
  );
}

/**
 * Resolve the Vivado launcher: config → env → null.
 * When null, the core probes common install locations and PATH.
 */
export function resolveVivadoBin({ configVivadoBin = null, env = process.env, fileExists = isFile } = {}) {
  if (configVivadoBin) {
    const resolved = path.resolve(String(configVivadoBin));
    if (!fileExists(resolved)) {
      throw new Error(`[vivado-plugin] config.vivadoBin does not exist: ${resolved}. Check the Vivado installation path or omit the option so the plugin can auto-detect it.`);
    }
    return resolved;
  }
  if (env.VIVADO_BIN) {
    const resolved = path.resolve(String(env.VIVADO_BIN));
    return fileExists(resolved) ? resolved : env.VIVADO_BIN;
  }
  return null;
}

/** 构造原生 ToolDefinition（不依赖 defineTool；registry 只校验 output.schema/render） */
function createToolDefinition(tool) {
  return {
    name: tool.name,
    description: tool.description,
    // parameters 会由 registry 原样投影给模型（只要求无损 JSON），直接复用 MCP 的 inputSchema
    parameters: tool.inputSchema,
    output: {
      // annotation-only schema：受支持 JSON Schema 子集里的空 schema，接受任意 JSON 值
      schema: {},
      // render 必须是 total/不抛错的纯函数
      render(args, value) {
        try {
          const text = value && typeof value === 'object' && value.text != null ? String(value.text) : '';
          return [{ type: 'text', text }];
        } catch {
          return [{ type: 'text', text: '（工具输出渲染失败）' }];
        }
      },
    },
    // 与 MCP 版 toolCallTimeoutMs 对齐；超时会 abort signal，execute 把它传给 callTool 协作取消
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const result = await callTool(tool.name, args, {
        isCancelled: () => exec?.signal?.aborted === true,
      });
      const text = (result.content || [])
        .map((part) => (part && part.type === 'text' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (result.isError) {
        // 失败以抛错形式交给 registry，模型会看到文本（与 MCP 版 isError 语义一致）
        throw new Error(text || `vivado 工具调用失败：${tool.name}`);
      }
      // 保证返回值是无损 JSON（structuredContent 里可能存在 undefined 字段，registry 会拒绝）
      let structured = null;
      if (result.structuredContent != null) {
        structured = JSON.parse(JSON.stringify(result.structuredContent));
      }
      return { text: text || '（无输出）', structured };
    },
  };
}

/**
 * Cordis plugin entry: resolve the environment, then register the 14 `vivado_*` tools natively.
 *
 * Project resolution is deliberately environment/config driven and never falls back
 * to this package's own directory: the plugin lives in a DSH profile, not in a Vivado
 * project. When no default project is configured, tools require `project_dir` per call.
 *
 * @param {object} ctx Cordis context (inject guarantees ctx.tools)
 * @param {{projectDir?:string, vivadoBin?:string, nodeBin?:string}} [config]
 */
export function apply(ctx, config = {}) {
  const rawConfig = config && typeof config === 'object' ? config : {};
  const env = process.env;

  // 1) Default project: explicit config → existing env → none (tools take project_dir).
  const configuredProject = rawConfig.projectDir || env.VIVADO_PROJECT_ROOT || null;
  const projectDir = configuredProject ? path.resolve(String(configuredProject)) : null;
  if (projectDir && !existsSync(projectDir)) {
    throw new Error(`[vivado-plugin] project directory does not exist: ${projectDir}. Fix bundle config projectDir or VIVADO_PROJECT_ROOT.`);
  }

  // 2) Vivado launcher (optional; core auto-detects when unset).
  const vivadoBin = resolveVivadoBin({ configVivadoBin: rawConfig.vivadoBin || null, env });

  // 3) A real node executable (core/jobs.mjs reads process.env.VIVADO_MCP_NODE).
  const nodeResolution = resolveNodeBinary({ configNodeBin: rawConfig.nodeBin || null, env });

  // 4) Persist into the process environment: the core defaults to process.env and
  //    background job children inherit it.
  if (projectDir) env.VIVADO_PROJECT_ROOT = projectDir;
  if (vivadoBin) env.VIVADO_BIN = vivadoBin;
  env.VIVADO_MCP_NODE = nodeResolution.path;

  try {
    ctx.logger?.info?.(
      `[vivado-plugin] projectDir=${projectDir || '(not configured; pass project_dir per call)'} vivadoBin=${vivadoBin || '(auto-detect)'} nodeBin=${nodeResolution.path} (source ${nodeResolution.source})`,
    );
  } catch {
    /* logging must never break registration */
  }

  // 5) Register the 14 tools natively; the effect unregisters them on plugin disposal/HMR.
  const tools = listToolDefinitions();
  const definitions = tools.map((tool) => createToolDefinition(tool));

  ctx.effect(() => {
    const disposers = [];
    try {
      for (const definition of definitions) {
        disposers.push(ctx.tools.register(definition));
      }
    } catch (error) {
      // 注册失败时回滚已注册的部分，避免留下半套工具
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, 'vivado-plugin.tools');

  return {
    toolCount: definitions.length,
    projectDir,
    vivadoBin: vivadoBin || null,
    nodeBin: nodeResolution.path,
    nodeBinSource: nodeResolution.source,
  };
}
