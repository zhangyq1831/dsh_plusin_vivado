// JSON-RPC 2.0 基础：错误码、帧序列化（newline-delimited）。
export const RPC_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

export class RpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** 序列化为一行 JSON（MCP stdio 传输是 newline-delimited，没有 Content-Length 头） */
export function serializeMessage(message) {
  return JSON.stringify(message) + '\n';
}

/** 成功响应 */
export function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** 错误响应 */
export function makeError(id, code, message, data = undefined) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
