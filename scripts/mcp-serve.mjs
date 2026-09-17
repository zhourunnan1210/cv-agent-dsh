/**
 * MCP 服务端入口（stdio）：把 cv-research 的知识库通过 MCP 暴露给**其它 agent 运行时**。
 *
 * 用法（在任意支持 MCP 的客户端里把它配成 stdio server）：
 *
 *     node scripts/mcp-serve.mjs [--db <metadata.db 路径>]
 *
 * 默认库路径 `data/papers/metadata.db`（相对宿主进程 cwd，与 dsh 侧一致）。
 *
 * ## stdout 是协议流
 *
 * **任何日志都只能走 stderr**——往 stdout 打一行字就会污染协议流，客户端直接断开。
 * 这是 MCP over stdio 最常见的翻车点，所以本文件里没有一处 `console.log`。
 *
 * ## idea_score 需要裁判
 *
 * 打分的语义判断由 LLM 裁判完成（§11.8）。本进程**不接模型**，因此 `idea_score`
 * 默认会明确回报"未配置裁判"，而不是用一个假的确定性分数糊过去——那会让外部客户端
 * 以为拿到的是与 dsh 内一致的四维评分。需要真打分时，请用 dsh 会话里的
 * `cvagent_idea_score`（那边有 LLM 裁判）。
 *
 * @module scripts/mcp-serve
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const requireFromPlugin = createRequire(resolve(repoRoot, 'packages/dsh-plugin/package.json'))

/** 从构建产物加载：MCP 协议层与 kb 适配器（都不需要 Cordis）。 */
const mcp = await import(pathToFileURL(resolve(repoRoot, 'packages/mcp-server/lib/index.js')).href)
const { createCoreKnowledgeBase } = await import(
  pathToFileURL(requireFromPlugin.resolve('cv-agent-dsh/mcp')).href
)

/** 解析 `--db <path>`；缺省用与 dsh 侧相同的相对路径。 */
function parseDbPath(argv) {
  const index = argv.indexOf('--db')
  const fromArg = index === -1 ? undefined : argv[index + 1]
  return resolve(repoRoot, fromArg ?? 'data/papers/metadata.db')
}

const dbPath = parseDbPath(process.argv.slice(2))
if (!existsSync(dbPath)) {
  // stderr：stdout 只能放协议消息
  process.stderr.write(`[cv-research-mcp] 找不到知识库：${dbPath}\n`)
  process.exit(1)
}

const adapter = createCoreKnowledgeBase({ dbPath })

/**
 * 未接裁判时的 `IdeaScorer`：**明确拒绝**而不是返回假分数。
 *
 * 这样 `idea_score` 的失败是"告诉你为什么"，而不是"给你一个看起来像真的、其实没有语义判断的分数"。
 */
const scorerWithoutJudge = {
  async score() {
    throw new Error(
      '本进程未配置 LLM 裁判，无法完成四维打分（打分里的语义判断必须由裁判做）。'
      + '请在 dsh 会话里用 cvagent_idea_score（那边有裁判），或给本服务注入一个 IdeaScorer。',
    )
  },
}

const server = mcp.createMcpServer({ kb: adapter.kb, scorer: scorerWithoutJudge })
server.serve()

process.stderr.write(
  `[cv-research-mcp] serving ${dbPath}\n`
  + `[cv-research-mcp] tools: ${server.context.tools.map((tool) => tool.definition.name).join(', ')}\n`,
)

/** 退出时关掉 sqlite（Windows 下不关会留下锁文件）。 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    adapter.close()
    process.exit(0)
  })
}
