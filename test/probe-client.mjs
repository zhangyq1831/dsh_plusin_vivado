#!/usr/bin/env node
// 零依赖 MCP probe 客户端：证明本仓库 server 的 stdio 握手/工具发现/tools/call 可用。
// 可被 test/run-tests.mjs 作为库使用，也可直接运行（打印握手摘要）：
//   node tools/vivado-mcp/test/probe-client.mjs [--server src/server.mjs] [--project DIR] [--tool vivado_project_info]
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const DEFAULT_SERVER = path.join(PACKAGE_ROOT, 'src', 'server.mjs');

export class ProbeError extends Error {
  constructor(message, code = null, data = undefined) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
    this.data = data;
  }
}

/** 极简 MCP stdio 客户端（newline-delimited JSON-RPC 2.0） */
export class McpProbeClient {
  constructor({ command = process.execPath, args = [DEFAULT_SERVER], cwd = PACKAGE_ROOT, env = process.env, name = 'vivado-mcp-probe' } = {}) {
    this.options = { command, args, cwd, env };
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderrText = '';
    this.rawLines = 0;
    this.closed = false;
    this.child = null;
    this.rl = null;
  }

  static async connect(options = {}) {
    const client = new McpProbeClient(options);
    await client.start();
    return client;
  }

  async start() {
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrText += chunk.toString('utf8');
      if (this.stderrText.length > 200000) this.stderrText = this.stderrText.slice(-100000);
    });
    this.child.on('error', (err) => {
      for (const pending of this.pending.values()) pending.reject(new ProbeError(`server 进程错误：${err.message}`));
      this.pending.clear();
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new ProbeError(`server 已退出（code=${code}, signal=${signal}）`));
      this.pending.clear();
    });
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity, terminal: false });
    this.rl.on('line', (line) => this.#onLine(line));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return this;
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.rawLines++;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      throw new ProbeError(`server stdout 出现非 JSON 行（协议被污染）：${trimmed.slice(0, 200)}`);
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new ProbeError(message.error.message || 'JSON-RPC 错误', message.error.code, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // server 通知（本工具链不主动发，忽略但记录）
    this.notifications.push(message);
  }

  request(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new ProbeError('连接已关闭'));
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method };
    if (params !== undefined) frame.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProbeError(`请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  notify(method, params = undefined) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  async initialize({ protocolVersion = '2025-06-18', clientInfo = { name: this.name, version: '0.0.1' } } = {}) {
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: { tools: {} },
      clientInfo,
    });
    this.initializeResult = result;
    this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args = {}) {
    return await this.request('tools/call', { name, arguments: args }, { timeoutMs: 300000 });
  }

  /** 发送原始行（用于非法帧测试） */
  writeRaw(text) {
    this.child.stdin.write(text);
  }

  async close() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 2000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.closed = true;
  }
}

/** 直接运行时的自检摘要 */
async function main() {
  const argv = process.argv.slice(2);
  const getOpt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const server = getOpt('--server') || DEFAULT_SERVER;
  const project = getOpt('--project');
  const tool = getOpt('--tool') || 'vivado_project_info';
  const env = {};
  if (project) env.VIVADO_PROJECT_ROOT = path.resolve(project);

  const client = await McpProbeClient.connect({ args: [server], env });
  const summary = { server, project: project || process.env.VIVADO_PROJECT_ROOT || null };
  try {
    const init = await client.initialize({ protocolVersion: '2025-11-25', clientInfo: { name: 'vivado-mcp-probe', version: '0.0.1' } });
    summary.protocolVersion = init.protocolVersion;
    summary.serverInfo = init.serverInfo;
    summary.capabilities = init.capabilities;
    summary.instructionsBytes = Buffer.byteLength(init.instructions || '', 'utf8');
    const tools = await client.listTools();
    summary.toolCount = tools.length;
    summary.tools = tools.map((t) => t.name);
    const ping = await client.request('ping', {});
    summary.ping = ping;
    const result = await client.callTool(tool, project ? { project_dir: path.resolve(project) } : {});
    const structured = result.structuredContent || {};
    summary.call = {
      tool,
      isError: !!result.isError,
      contentTextHead: (result.content?.[0]?.text || '').slice(0, 300),
      structuredKeys: Object.keys(structured).slice(0, 20),
    };
    if (tool === 'vivado_project_info') {
      summary.call.part = structured.part;
      summary.call.designTop = structured.design?.top;
      summary.call.simTop = structured.sim?.top;
      summary.call.currentRun = structured.currentRun;
    }
  } catch (err) {
    summary.error = err instanceof ProbeError ? { message: err.message, code: err.code, data: err.data } : { message: String(err) };
    summary.serverStderrTail = client.stderrText.split(/\r?\n/).slice(-20).join('\n');
    console.log(JSON.stringify(summary, null, 2));
    await client.close();
    process.exit(1);
  }
  console.log(JSON.stringify(summary, null, 2));
  await client.close();
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
