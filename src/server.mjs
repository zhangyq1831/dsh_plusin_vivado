#!/usr/bin/env node
// Vivado MCP server：stdio + newline-delimited JSON-RPC 2.0，零 npm 依赖、自己实现 MCP 协议。
// stdout 只写协议帧；所有日志/诊断走 stderr。
// 支持：initialize（中文 instructions）/ tools/list / tools/call / ping；忽略 initialized/cancelled 通知。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PACKAGE_ROOT, ENV } from './core/config.mjs';
import { INSTRUCTIONS, SERVER_NAME } from './mcp/instructions.mjs';
import { callTool, listToolDefinitions, TOOL_NAMES } from './mcp/tools.mjs';
import { makeError, makeResult, RPC_ERROR, RpcError, serializeMessage } from './mcp/protocol.mjs';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

function readPackageInfo() {
  try {
    const text = fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8');
    const pkg = JSON.parse(text);
    return { name: SERVER_NAME, version: pkg.version || '0.1.0' };
  } catch {
    return { name: SERVER_NAME, version: '0.1.0' };
  }
}
const SERVER_INFO = readPackageInfo();

function log(message) {
  try {
    process.stderr.write(`[vivado-mcp ${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/** 协商 protocolVersion：client 提供且我们支持则原样；更新版本回退到我们支持的最新版 */
function negotiateProtocol(clientVersion) {
  const v = typeof clientVersion === 'string' ? clientVersion.trim() : '';
  if (!v) return DEFAULT_PROTOCOL;
  if (SUPPORTED_PROTOCOLS.includes(v)) return v;
  // 客户端给的是更新版（如 2025-11-25 / 2026-07-28）→ 回退到我们实现的 2025-06-18 语义
  if (v > DEFAULT_PROTOCOL) return DEFAULT_PROTOCOL;
  if (v > '2025-03-26') return '2025-03-26';
  if (v > '2024-11-05') return '2024-11-05';
  return '2024-11-05';
}

const cancelledRequestIds = new Set();
let initialized = false;
let shutdown = false;

function send(message) {
  if (shutdown) return;
  try {
    process.stdout.write(serializeMessage(message));
  } catch (err) {
    log(`写 stdout 失败：${err && err.message ? err.message : err}`);
  }
}

function sendResult(id, result) {
  send(makeResult(id, result));
}

function sendError(id, err) {
  if (err instanceof RpcError) {
    send(makeError(id, err.code, err.message, err.data));
    return;
  }
  const message = err && err.message ? err.message : String(err);
  log(`处理请求失败：${err && err.stack ? err.stack : message}`);
  send(makeError(id, RPC_ERROR.INTERNAL_ERROR, `内部错误：${message}`));
}

/** 构造 initialize 响应 */
function handleInitialize(params) {
  const clientVersion = params && typeof params === 'object' ? params.protocolVersion : undefined;
  const negotiated = negotiateProtocol(clientVersion);
  const clientInfo = params && params.clientInfo ? params.clientInfo : null;
  initialized = true;
  log(
    `initialize：client=${clientInfo ? `${clientInfo.name || '?'}@${clientInfo.version || '?'}` : '未知'}，请求协议=${clientVersion || '未提供'}，协商结果=${negotiated}`,
  );
  return {
    protocolVersion: negotiated,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
    },
    instructions: INSTRUCTIONS,
  };
}

/** 处理一个请求（有 id 的 JSON-RPC） */
async function handleRequest(message) {
  const id = message.id;
  const method = message.method;
  const params = message.params;
  switch (method) {
    case 'initialize':
      return handleInitialize(params);
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listToolDefinitions() };
    case 'tools/call': {
      if (!params || typeof params !== 'object') {
        throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'tools/call 缺少 params');
      }
      const name = params.name;
      if (typeof name !== 'string' || name.trim() === '') {
        throw new RpcError(RPC_ERROR.INVALID_PARAMS, 'tools/call 缺少工具名 name');
      }
      const startedAt = Date.now();
      log(`tools/call ${name}${params.arguments ? ` args=${JSON.stringify(params.arguments).slice(0, 500)}` : ''}`);
      const result = await callTool(name, params.arguments, {
        isCancelled: () => cancelledRequestIds.has(id),
      });
      log(`tools/call ${name} 完成（${Date.now() - startedAt}ms，isError=${!!result.isError}）`);
      return result;
    }
    default:
      throw new RpcError(RPC_ERROR.METHOD_NOT_FOUND, `未知方法：${method}`, { supported: ['initialize', 'ping', 'tools/list', 'tools/call'] });
  }
}

function handleNotification(message) {
  const method = message.method;
  if (method === 'notifications/initialized') {
    log('收到 notifications/initialized');
    return;
  }
  if (method === 'notifications/cancelled') {
    const requestId = message.params && message.params.requestId;
    if (requestId !== undefined && requestId !== null) cancelledRequestIds.add(requestId);
    log(`收到 notifications/cancelled requestId=${requestId}`);
    return;
  }
  // 其它通知忽略（MCP 允许）
}

async function handleLine(line) {
  const trimmed = String(line || '').trim();
  if (trimmed === '') return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send(makeError(null, RPC_ERROR.PARSE_ERROR, 'JSON 解析失败：请求必须是单行 JSON-RPC 2.0'));
    return;
  }
  if (Array.isArray(message)) {
    send(makeError(null, RPC_ERROR.INVALID_REQUEST, '不支持 JSON-RPC 批量请求'));
    return;
  }
  if (!message || typeof message !== 'object') {
    send(makeError(null, RPC_ERROR.INVALID_REQUEST, '无效的 JSON-RPC 消息'));
    return;
  }
  const hasMethod = typeof message.method === 'string';
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (hasMethod && !hasId) {
    handleNotification(message);
    return;
  }
  if (hasMethod) {
    try {
      const result = await handleRequest(message);
      sendResult(message.id, result);
    } catch (err) {
      sendError(message.id, err);
    }
    return;
  }
  if (message.result !== undefined || message.error !== undefined) {
    // 客户端对我们发起请求的响应（本 server 不主动发请求，忽略）
    return;
  }
  if (hasId) {
    send(makeError(message.id, RPC_ERROR.INVALID_REQUEST, '无效的 JSON-RPC 请求（缺少 method）'));
  }
}

function finishAndExit(code) {
  if (shutdown) return;
  shutdown = true;
  log(`server 退出（code=${code}）`);
  // 给 stdout 一点时间把最后的响应刷出去
  setTimeout(() => process.exit(code), 50);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_INFO.name} ${SERVER_INFO.version}\n`);
    process.exit(0);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      'Vivado MCP server（stdio JSON-RPC）\n用法：node src/server.mjs\n环境变量：VIVADO_PROJECT_ROOT、VIVADO_BIN、VIVADO_MCP_TCL_DIR\n',
    );
    process.exit(0);
  }

  log(`启动：version=${SERVER_INFO.version} node=${process.version} pid=${process.pid}`);
  log(`工程根环境变量 ${ENV.projectRoot}=${process.env[ENV.projectRoot] || '(未设置)'}；${ENV.vivadoBin}=${process.env[ENV.vivadoBin] || '(未设置，自动探测)'}`);
  log(`工具：${TOOL_NAMES.join(', ')}`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', (line) => {
    void handleLine(line);
  });
  rl.on('close', () => {
    log('stdin 关闭');
    finishAndExit(0);
  });
  process.stdin.on('error', (err) => {
    log(`stdin 错误：${err && err.message ? err.message : err}`);
    finishAndExit(0);
  });
  process.stdout.on('error', (err) => {
    log(`stdout 错误（对端可能已关闭）：${err && err.message ? err.message : err}`);
  });
  process.on('SIGINT', () => finishAndExit(0));
  process.on('SIGTERM', () => finishAndExit(0));
  process.on('uncaughtException', (err) => {
    log(`未捕获异常：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`);
  });
}

main();
