// 通用错误类型：用于在 core 层抛出，MCP/CLI 层再映射为结构化结果。
export class McpError extends Error {
  /**
   * @param {string} message 面向 Agent/用户的中文错误说明
   * @param {object} [options]
   * @param {string} [options.code] 机器可读错误码
   * @param {string} [options.hint] 修复建议
   * @param {'invalid_params'|'environment'|'business'|'internal'} [options.kind]
   * @param {object} [options.details]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'McpError';
    this.code = options.code || 'VMCP_ERROR';
    this.hint = options.hint || '';
    this.kind = options.kind || 'environment';
    this.details = options.details || undefined;
  }
}

/** 参数错误（工具参数不合法） */
export function argError(message, hint = '') {
  return new McpError(message, { code: 'INVALID_ARGUMENT', kind: 'invalid_params', hint });
}

/** 环境/发现类错误（找不到 Vivado、找不到工程等）；details.code 可覆盖默认错误码 */
export function envError(message, hint = '', details = undefined) {
  const code = details && details.code ? String(details.code) : 'ENVIRONMENT';
  return new McpError(message, { code, kind: 'environment', hint, details });
}

/** 业务冲突类错误（例如已有构建 job 在跑、工程被锁） */
export function conflictError(message, hint = '', details) {
  return new McpError(message, { code: 'CONFLICT', kind: 'business', hint, details });
}

/** 把任意异常转为 McpError */
export function toMcpError(err) {
  if (err instanceof McpError) return err;
  const message = err && err.message ? String(err.message) : String(err);
  const wrapped = new McpError(`内部错误：${message}`, { code: 'INTERNAL', kind: 'internal' });
  wrapped.cause = err;
  return wrapped;
}
