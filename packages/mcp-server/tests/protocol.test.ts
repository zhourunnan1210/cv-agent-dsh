/**
 * MCP 协议层测试（Spike S5 落地）。
 *
 * 测的是**协议行为**，不是我们的实现细节：一个 MCP 客户端按规范发消息，
 * 服务端必须按规范回。所以这里的断言都写成"客户端视角"——
 * `initialize` 要给 `protocolVersion` / `capabilities.tools` / `serverInfo`，
 * `tools/list` 要给带 `inputSchema` 的工具表，`tools/call` 要给 `content` 数组。
 *
 * 另一类是**边界与失败**：非法 JSON、未知方法、未知工具、工具内部抛错。
 * 其中"工具失败返回 `isError` 结果而不是 JSON-RPC error"是刻意的契约
 * （见 protocol.ts 的说明），这里把它钉死。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
  handleMessage,
  jsonResult,
  negotiateVersion,
  textResult,
  type McpTool,
  type ProtocolContext,
} from '../src/protocol.js'

const ECHO_TOOL: McpTool = {
  definition: {
    name: 'echo',
    description: '回显输入',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  handler: async (args) => jsonResult({ echoed: args.text }),
}

const BOOM_TOOL: McpTool = {
  definition: { name: 'boom', description: '总是抛错', inputSchema: { type: 'object' } },
  handler: async () => {
    throw new Error('内部炸了')
  },
}

const context: ProtocolContext = {
  serverInfo: { name: 'cv-research', version: '0.1.0' },
  tools: [ECHO_TOOL, BOOM_TOOL],
}

/** 发一条消息并解析答复（断言行文本可被 JSON.parse，本身也是协议要求）。 */
async function call(message: unknown): Promise<Record<string, unknown>> {
  const reply = await handleMessage(JSON.stringify(message), context)
  expect(reply, '这条消息应当有应答').toBeTypeOf('string')
  expect(reply, '一条消息必须是一行（协议要求消息内无裸换行）').not.toContain('\n')
  return JSON.parse(reply as string) as Record<string, unknown>
}

describe('MCP 协议层', () => {
  it('initialize：回协议版本、tools 能力与服务端身份', async () => {
    const response = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '1' } } })
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cv-research', version: '0.1.0' },
    })
  })

  it('initialize：客户端报一个我们不认识的版本时回落默认（不因此断开）', () => {
    expect(negotiateVersion('1999-01-01')).toBe(DEFAULT_PROTOCOL_VERSION)
    expect(negotiateVersion('2024-11-05')).toBe('2024-11-05')
    expect(negotiateVersion(undefined)).toBe(DEFAULT_PROTOCOL_VERSION)
  })

  it('ping：回空对象（保活）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 'p1', method: 'ping' })
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 'p1', result: {} })
  })

  it('tools/list：给出工具表，且每个工具带 inputSchema（客户端据此构造入参）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const tools = (response.result as { tools: Array<Record<string, unknown>> }).tools
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'boom'])
    for (const tool of tools) {
      expect(tool.description).toBeTypeOf('string')
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
    }
  })

  it('tools/call：正常返回 content 数组（文本块）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: '你好' } } })
    const result = response.result as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(result.content[0].type).toBe('text')
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: '你好' })
  })

  it('通知（无 id）：不应答（notifications/initialized 是 MCP 握手的一步）', async () => {
    const reply = await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), context)
    expect(reply).toBeUndefined()
  })

  it('非法 JSON → parseError，且 id 为 null', async () => {
    const reply = await handleMessage('{ 这不是 JSON', context)
    const response = JSON.parse(reply as string) as Record<string, unknown>
    expect(response.id).toBeNull()
    expect((response.error as { code: number }).code).toBe(JSON_RPC_ERRORS.parseError)
  })

  it('缺 method → invalidRequest', async () => {
    const response = await call({ jsonrpc: '2.0', id: 4, foo: 'bar' })
    expect((response.error as { code: number }).code).toBe(JSON_RPC_ERRORS.invalidRequest)
  })

  it('未知方法 → methodNotFound（但要先排除通知）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
    expect((response.error as { code: number }).code).toBe(JSON_RPC_ERRORS.methodNotFound)
    const notification = await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'resources/list' }), context)
    expect(notification).toBeUndefined()
  })

  it('未知工具 → invalidParams（协议级错误：重试无意义）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    expect((response.error as { code: number }).code).toBe(JSON_RPC_ERRORS.invalidParams)
    expect((response.error as { message: string }).message).toContain('nope')
  })

  it('arguments 不是对象 → invalidParams', async () => {
    const response = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: ['x'] } })
    expect((response.error as { code: number }).code).toBe(JSON_RPC_ERRORS.invalidParams)
  })

  it('工具内部抛错 → 仍是**成功应答**里的 isError 结果（不是协议错误）', async () => {
    const response = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom', arguments: {} } })
    expect(response.error, '工具失败不该变成协议错误——客户端要能看见原因并继续').toBeUndefined()
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('内部炸了')
  })

  it('工具的 arguments 缺省视为空对象（无参工具可省 arguments）', async () => {
    const tool: McpTool = {
      definition: { name: 'noargs', description: '无参', inputSchema: { type: 'object' } },
      handler: async (args) => jsonResult({ got: Object.keys(args).length }),
    }
    const reply = await handleMessage(
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'noargs' } }),
      { serverInfo: context.serverInfo, tools: [tool] },
    )
    expect(JSON.parse((JSON.parse(reply as string) as { result: { content: Array<{ text: string }> } }).result.content[0].text)).toEqual({ got: 0 })
  })

  it('textResult / jsonResult 的形状固定（工具作者不必各自拼 content 块）', () => {
    expect(textResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] })
    expect(textResult('bad', true)).toMatchObject({ isError: true })
    expect(jsonResult({ a: 1 }).content[0].text).toContain('"a": 1')
  })

  it('handler 只被调用一次（协议层不重放工具）', async () => {
    const spy = vi.fn(async () => textResult('ok'))
    const tool: McpTool = { definition: { name: 'count', description: 'x', inputSchema: { type: 'object' } }, handler: spy }
    const ctx = { serverInfo: context.serverInfo, tools: [tool] }
    await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'count', arguments: {} } }), ctx)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
