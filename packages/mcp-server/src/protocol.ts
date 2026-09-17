/**
 * MCP 协议层：JSON-RPC 2.0 消息的**纯函数**处理。
 *
 * ## 为什么自己写而不是引 SDK
 *
 * `@cv-research/mcp` 的设计约束（见 `index.ts`）：**只依赖 `@cv-research/core`**，
 * 不引入 dsh / Cordis。MCP 的 stdio 传输是「一行一个 JSON-RPC 消息」（换行分隔，
 * 消息内不含裸换行），服务端需要实现的方法只有四个：`initialize` / `ping` /
 * `tools/list` / `tools/call`。为这四个方法引一个运行时依赖，代价大于收益
 * （也让"跨平台复用面"多一个版本约束）。
 *
 * 本文件**不碰任何 I/O**：`handleMessage` 是纯函数，输入一行文本、输出一行文本
 * （或 `undefined` = 通知，无需应答）。stdio 循环在 `server.ts`。
 * 这样协议行为可以直接单测，不需要起进程、也不需要管道。
 *
 * @module @cv-research/mcp/protocol
 */

/** 本服务端支持的 MCP 协议版本（实现时对齐的规范版本）。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

/** 默认返回的版本：客户端没指定、或指定了我们不认识的版本时用它。 */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/** JSON-RPC 2.0 标准错误码。 */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id?: string | number | null
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

/** MCP 工具定义（`tools/list` 的元素）。 */
export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  /** JSON Schema（对象根）。 */
  readonly inputSchema: Record<string, unknown>
}

/** `tools/call` 的结果：内容块数组 + 可选错误标记（MCP 约定：工具失败也返回 result）。 */
export interface McpToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
  readonly isError?: boolean
}

/**
 * 一个可被 MCP 暴露的能力。
 *
 * `handler` 收到的是 `tools/call` 的 `arguments`（已确认是对象），返回 MCP 结果。
 * 抛错由协议层收成 `isError: true` 的结果——**工具失败不该变成协议错误**：
 * 客户端（另一个 agent 运行时）需要看见失败原因并继续对话，而不是拿到一个
 * JSON-RPC error 后不知所措。
 */
export interface McpTool {
  readonly definition: McpToolDefinition
  readonly handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

/** 服务端身份（`initialize` 返回，客户端据此显示）。 */
export interface ServerIdentity {
  readonly name: string
  readonly version: string
}

/** `handleMessage` 需要的全部依赖。 */
export interface ProtocolContext {
  readonly serverInfo: ServerIdentity
  readonly tools: readonly McpTool[]
}

/** 把任意值安全地读成 JSON-RPC 请求；不是对象/没有 method 时返回 undefined。 */
function asRequest(value: unknown): JsonRpcRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.method !== 'string') return undefined
  return {
    jsonrpc: '2.0',
    ...(candidate.id === undefined ? {} : { id: candidate.id as string | number | null }),
    method: candidate.method,
    ...(candidate.params === undefined ? {} : { params: candidate.params }),
  }
}

function success(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

/** 工具结果的便捷构造：一段文本。 */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/** 工具结果的便捷构造：结构化对象（序列化成 JSON 文本；MCP 文本块是通用载体）。 */
export function jsonResult(value: unknown): McpToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

/**
 * 协商协议版本。
 *
 * 客户端在 `initialize` 里报它支持的版本；我们认识的版本就照它回（避免客户端
 * 因版本不符而断开），不认识则回自己的默认版本，由客户端决定是否继续。
 */
export function negotiateVersion(requested: unknown): string {
  if (typeof requested !== 'string') return DEFAULT_PROTOCOL_VERSION
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION
}

/**
 * 处理一行 JSON-RPC 消息。
 *
 * @param line - 一行原始文本（stdio 传输的读入单位）。
 * @param context - 服务端身份与工具表。
 * @returns 要写回的**一行**文本；`undefined` 表示这是通知、无需应答。
 */
export async function handleMessage(line: string, context: ProtocolContext): Promise<string | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return JSON.stringify(failure(null, JSON_RPC_ERRORS.parseError, 'JSON 解析失败', String(error)))
  }

  const request = asRequest(parsed)
  if (request === undefined) {
    return JSON.stringify(failure(null, JSON_RPC_ERRORS.invalidRequest, '不是合法的 JSON-RPC 请求（缺 method）'))
  }

  // 通知（无 id）：不需要应答。MCP 里最常见的是 notifications/initialized。
  const isNotification = request.id === undefined
  const id = request.id ?? null

  try {
    switch (request.method) {
      case 'initialize': {
        const params = (request.params ?? {}) as Record<string, unknown>
        return JSON.stringify(success(id, {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: context.serverInfo,
        }))
      }

      case 'ping':
        return JSON.stringify(success(id, {}))

      case 'tools/list':
        return JSON.stringify(success(id, {
          tools: context.tools.map((tool) => tool.definition),
        }))

      case 'tools/call': {
        const params = (request.params ?? {}) as Record<string, unknown>
        const name = params.name
        if (typeof name !== 'string') {
          return JSON.stringify(failure(id, JSON_RPC_ERRORS.invalidParams, 'tools/call 缺少 name'))
        }
        const tool = context.tools.find((candidate) => candidate.definition.name === name)
        if (tool === undefined) {
          // 未知工具名是**协议级**错误：客户端问了一个不存在的工具，重试也没用。
          return JSON.stringify(failure(id, JSON_RPC_ERRORS.invalidParams, `未知工具：${name}`))
        }
        const rawArgs = params.arguments
        if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
          return JSON.stringify(failure(id, JSON_RPC_ERRORS.invalidParams, 'tools/call 的 arguments 必须是对象'))
        }
        const args = (rawArgs ?? {}) as Record<string, unknown>
        try {
          return JSON.stringify(success(id, await tool.handler(args)))
        } catch (error) {
          // 工具自身失败 → 结果是 isError 文本，而不是协议错误（见 McpTool 的说明）。
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify(success(id, textResult(`Error: ${message}`, true)))
        }
      }

      default:
        if (isNotification) return undefined
        return JSON.stringify(failure(id, JSON_RPC_ERRORS.methodNotFound, `不支持的方法：${request.method}`))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify(failure(id, JSON_RPC_ERRORS.internalError, message))
  }
}
