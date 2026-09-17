/**
 * @cv-research/mcp —— 核心能力的 MCP 服务化封装（v1.2 §12 的 Spike S5 落地）。
 *
 * ## 它是什么
 *
 * 把 core 已经声明好的两个平台无关契约——`KnowledgeBase`（知识库读写检索）与
 * `IdeaScorer`（idea 打分）——通过 **MCP（Model Context Protocol）** 暴露出去，
 * 让 dsh 之外的 agent 运行时（Claude Code / Codex / 自研客户端）也能用同一套
 * 知识库与打分逻辑。
 *
 * 这是 v1.2 §3.3「不锁定单一 Agent 运行时」的落点：能力在 core，用法在适配层，
 * MCP 是那个跨平台的复用面。
 *
 * ## 现状（2026-09-17）
 *
 * | 能力 | 状态 |
 * | --- | --- |
 * | 协议层（`initialize` / `ping` / `tools/list` / `tools/call`） | ✅ 已实现（`protocol.ts`） |
 * | 三个工具 `kb_search` / `kb_summary` / `idea_score` | ✅ 已实现（`tools.ts`） |
 * | stdio 服务端（一行一个 JSON-RPC 消息） | ✅ 已实现（`server.ts`） |
 * | 真实数据适配（sqlite → `KnowledgeBase` / `IdeaScorer`） | ⏳ 由宿主注入，见下 |
 *
 * ## 设计约束（提前记录，避免后续返工）
 *
 * 1. 本包只依赖 `@cv-research/core`，**不依赖 dsh / Cordis**——跨平台复用面。
 * 2. 暴露的能力必须是 core 层已有的平台无关接口，不得为了 MCP 而在
 *    core 里新增 dsh 相关概念。
 * 3. 凭证同样走环境变量 / credentials 注入，密钥字面值不进入任何返回值
 *    （v1.2 §23 密钥卫生）。本层**不读环境变量**：需要密钥的实现由宿主注入。
 * 4. 降级标记（`RetrievalResult.mode`）必须原样透给客户端，不得吞掉（v1.2 §19）。
 *
 * ## 怎么用
 *
 * ```ts
 * import { createMcpServer } from '@cv-research/mcp'
 *
 * // kb / scorer 由宿主提供（core 的两个接口的任意实现）
 * const server = createMcpServer({ kb, scorer })
 * server.serve()               // 挂到 stdio，等待 MCP 客户端
 * ```
 *
 * @module @cv-research/mcp
 */

export {
  DEFAULT_PROTOCOL_VERSION,
  JSON_RPC_ERRORS,
  SUPPORTED_PROTOCOL_VERSIONS,
  handleMessage,
  jsonResult,
  negotiateVersion,
  textResult,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type McpTool,
  type McpToolDefinition,
  type McpToolResult,
  type ProtocolContext,
  type ServerIdentity,
} from './protocol.js'

export { createTools } from './tools.js'
export {
  MCP_SERVER_IDENTITY,
  createMcpServer,
  type McpServer,
  type McpServerOptions,
} from './server.js'

export type { IdeaCandidate, IdeaScorer, KnowledgeBase, ScoringReport } from '@cv-research/core'
