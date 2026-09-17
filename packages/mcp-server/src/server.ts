/**
 * MCP 服务端：把 `KnowledgeBase` / `IdeaScorer` 通过 stdio 暴露给任意 MCP 客户端。
 *
 * 传输格式（MCP stdio）：**一行一个 JSON-RPC 消息**，消息内不含裸换行。
 * 服务端从可读流按行读、把应答写回可写流；`stderr` 留给日志（**不能写 stdout**，
 * 那会污染协议流——这是 MCP over stdio 最常见的翻车点）。
 *
 * @module @cv-research/mcp/server
 */

import { createInterface } from 'node:readline'

import { createTools } from './tools.js'
import {
  handleMessage,
  type McpTool,
  type ProtocolContext,
  type ServerIdentity,
} from './protocol.js'
import type { IdeaScorer, KnowledgeBase } from '@cv-research/core'

/** 本服务端的默认身份（客户端在 `initialize` 的应答里看到它）。 */
export const MCP_SERVER_IDENTITY: ServerIdentity = {
  name: 'cv-research',
  version: '0.1.0',
}

/** `createMcpServer` 的入参：宿主注入的两个 core 接口 + 可选身份/工具覆盖。 */
export interface McpServerOptions {
  readonly kb: KnowledgeBase
  readonly scorer: IdeaScorer
  readonly serverInfo?: ServerIdentity
  /** 覆盖工具表（测试与裁剪用）；缺省用 `createTools`。 */
  readonly tools?: readonly McpTool[]
}

export interface McpServer {
  readonly context: ProtocolContext
  /** 处理一行消息（纯转发到协议层；便于在进程内做端到端测试）。 */
  handle(line: string): Promise<string | undefined>
  /** 挂到 stdio 上开始服务；返回一个可停止的句柄。 */
  serve(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): { close(): void }
}

/**
 * 组装一个 MCP 服务端。
 *
 * 注意：**本函数不做任何 I/O**，`serve()` 才碰流。这样"工具行为"与"传输行为"
 * 可以分开测，也让宿主能在进程内直接调用（例如 dsh 插件想复用同一套工具定义）。
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const context: ProtocolContext = {
    serverInfo: options.serverInfo ?? MCP_SERVER_IDENTITY,
    tools: options.tools ?? createTools({ kb: options.kb, scorer: options.scorer }),
  }

  return {
    context,
    handle: (line) => handleMessage(line, context),
    serve(input = process.stdin, output = process.stdout) {
      const lines = createInterface({ input, crlfDelay: Infinity })
      let closed = false

      lines.on('line', (line) => {
        const trimmed = line.trim()
        if (trimmed === '') return
        void (async () => {
          const reply = await handleMessage(trimmed, context)
          if (reply === undefined || closed) return
          // 一条消息一行：协议要求消息内不能有裸换行，序列化结果本身不含。
          output.write(`${reply}\n`)
        })()
      })

      return {
        close() {
          closed = true
          lines.close()
        },
      }
    },
  }
}
