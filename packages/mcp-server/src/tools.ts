/**
 * 暴露为 MCP 工具的能力（v1.2 §12 的 Spike S5 落地）。
 *
 * ## 为什么是这三个
 *
 * S5 的原话是「把 `kb.search` + `idea.score` 两个接口包成 MCP，从 dsh 和另一个
 * MCP 客户端各调用一次」。这里按 core 已声明的契约落地成三个工具：
 *
 * | 工具 | core 契约 | 为什么要暴露 |
 * | --- | --- | --- |
 * | `kb_search` | `KnowledgeBase.similarProblems/similarMethods/similarFailures` | 撞车分析的核心查询；别的 agent 运行时（Claude Code / Codex）也需要能查这套知识库 |
 * | `kb_summary` | `KnowledgeBase.summarize` | 生成 idea 前的领域盘点；只读、便宜 |
 * | `idea_score` | `IdeaScorer.score` | 打分是"确定性算法 + 注入的 LLM 裁判"，把整条链交给注入的 `IdeaScorer` |
 *
 * ## 一个刻意的设计：降级标记必须原样透出
 *
 * `RetrievalResult.mode` 是 `vector | keyword_only`。**降级结果不能被当成等价结论**
 * （v1.2 §19 降级矩阵）——所以检索类工具的回包里永远带 `mode`，
 * 而不是把它藏在服务端实现里。MCP 客户端看得见"这次是关键词匹配"，才谈得上自己判断可信度。
 *
 * ## 密钥卫生（v1.2 §23）
 *
 * 本层不读环境变量、不接凭证：`KnowledgeBase` / `IdeaScorer` 由宿主注入，
 * 需要密钥的那一层在宿主里。**返回给客户端的任何字段都来自 core 的数据结构**，
 * 不存在把密钥写进工具结果的路径。
 *
 * @module @cv-research/mcp/tools
 */

import { createHash } from 'node:crypto'

import type {
  IdeaCandidate,
  IdeaScorer,
  KnowledgeBase,
  RetrievalResult,
  ScoredEntry,
} from '@cv-research/core'

import { jsonResult, type McpTool } from './protocol.js'

/** 四个库名（core 的 `StoreName`；这里显式列出以便校验入参）。 */
const STORE_NAMES = ['problems', 'methods', 'innovations', 'failures'] as const
type StoreName = (typeof STORE_NAMES)[number]

/** 默认返回条数（与 core 的 `ScoringThresholds.topk` 同量级）。 */
const DEFAULT_LIMIT = 5

/** 读取一个正整数入参，缺省给默认值，越界则夹住。 */
function readLimit(value: unknown, fallback = DEFAULT_LIMIT, max = 50): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(parsed)))
}

/** 读取必填字符串入参。 */
function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填参数 ${field}（非空字符串）`)
  }
  return value
}

/** 读取字符串数组入参（缺省空数组；顺带过滤非字符串与空串）。 */
function readStringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('该参数必须是字符串数组')
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/** 一次检索的归一化回包。 */
function shapeRetrieval(store: StoreName, result: RetrievalResult): Record<string, unknown> {
  return {
    store,
    // 降级标记随结果一起走，绝不吞掉（v1.2 §19）。
    mode: result.mode,
    hits: result.hits.map((hit: ScoredEntry) => ({
      entry_id: hit.entry.entry_id,
      statement: hit.entry.statement,
      source_papers: hit.entry.source_papers,
      score: hit.score,
    })),
  }
}

/**
 * 构造 MCP 工具表。
 *
 * @param ports - 宿主注入的实现；两个都是 core 已声明的接口，本包只消费不实现。
 * @returns 可直接挂到协议层的工具表。
 */
export function createTools(ports: { kb: KnowledgeBase; scorer: IdeaScorer }): readonly McpTool[] {
  const { kb, scorer } = ports

  const kbSearch: McpTool = {
    definition: {
      name: 'kb_search',
      description:
        '在 cv-research 知识库里检索条目（problems/methods/innovations/failures 四库）。'
        + '返回每条命中的 statement、来源论文与相似度，并**如实标注检索模式**'
        + '（mode=vector 为向量检索；mode=keyword_only 表示向量不可用、已降级为关键词匹配，'
        + '此时相似度是字符口径，不能与余弦阈值直接比较）。'
        + '用于撞车分析：新想法提出前，先在库里查有没有同题工作。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要检索的想法/方法/问题的自然语言描述' },
          stores: {
            type: 'array',
            items: { type: 'string', enum: [...STORE_NAMES] },
            description: `限定检索哪几个库；缺省查 problems 与 methods`,
          },
          limit: { type: 'integer', description: `每库返回条数（1–50，默认 ${DEFAULT_LIMIT}）` },
        },
        required: ['query'],
      },
    },
    async handler(args) {
      const query = readString(args.query, 'query')
      const stores = readStringArray(args.stores)
      const wanted = (stores.length === 0 ? ['problems', 'methods'] : stores) as string[]
      const limit = readLimit(args.limit)
      for (const store of wanted) {
        if (!(STORE_NAMES as readonly string[]).includes(store)) {
          throw new Error(`未知的库名：${store}（可选：${STORE_NAMES.join(' / ')}）`)
        }
      }

      const results: Record<string, unknown>[] = []
      for (const store of wanted) {
        // 三个库各有自己的检索方法（core 的契约如此）；用 switch 而不是动态取方法名，
        // 这样漏掉一个库是**编译错误**，而不是运行时 "is not a function"。
        switch (store as StoreName) {
          case 'problems':
            results.push(shapeRetrieval('problems', await kb.similarProblems(query, limit)))
            break
          case 'methods':
            results.push(shapeRetrieval('methods', await kb.similarMethods(query, limit)))
            break
          case 'failures':
            results.push(shapeRetrieval('failures', await kb.similarFailures(query, limit)))
            break
          case 'innovations':
            // core 目前没有 similarInnovations（创新库靠 summarize 盘点，不参与撞车召回）
            results.push({ store: 'innovations', mode: null, hits: [], note: 'core 未提供 innovations 的相似检索，改用 kb_summary' })
            break
        }
      }
      return jsonResult({ query, limit, results })
    },
  }

  const kbSummary: McpTool = {
    definition: {
      name: 'kb_summary',
      description:
        '知识库盘点：四库各自的条目数与代表条目（每库最多 limit 条）。'
        + '用于生成新想法前了解"这个领域已经被做过什么"。只读、不消耗检索额度。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: `每库返回几条代表条目（1–50，默认 ${DEFAULT_LIMIT}）` },
        },
      },
    },
    async handler(args) {
      const limit = readLimit(args.limit)
      const summary = await kb.summarize(limit)
      return jsonResult({
        counts: summary.counts,
        // 代表条目只给 statement 与来源，控制上下文占用（v1.2 §6.1 的"每库上限 N 条"）
        problems: summary.problems.map((entry) => ({ entry_id: entry.entry_id, statement: entry.statement })),
        methods: summary.methods.map((entry) => ({ entry_id: entry.entry_id, statement: entry.statement })),
        innovations: summary.innovations.map((entry) => ({ entry_id: entry.entry_id, statement: entry.statement })),
        failures: summary.failures.map((entry) => ({ entry_id: entry.entry_id, statement: entry.statement })),
      })
    },
  }

  const ideaScore: McpTool = {
    definition: {
      name: 'idea_score',
      description:
        '给一条候选 idea 打分：撞车分析（检索知识库 + 失败库复查）+ 四维打分，产出可核对的打分报告。'
        + '报告里带 retrieval_mode（检索是否降级）、dimension_trace（每个维度怎么算出来的）、'
        + 'evidence（逐条撞车判定与相似度）——数字都能指回来源。'
        + '⚠️ 打分里的语义判断由注入的裁判完成，本工具只负责确定性的检索与聚合。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string', description: '一句话说清这个想法是什么（必填）' },
          problem: { type: 'string', description: '它要解决什么问题（必填；撞车分析要用它检索问题库）' },
          method: { type: 'string', description: '打算怎么做（必填；撞车分析要用它检索方法库）' },
          innovation: { type: 'string', description: '可命名的具体机制（模块/损失/数据集/协议）；缺省空串，给了更利于判创新性' },
          baselines: { type: 'array', items: { type: 'string' }, description: '打算对比的基线论文 ID（缺省空数组）' },
          idea_id: { type: 'string', description: '调用方的 idea 标识；缺省按 statement 的哈希生成，保证同文同 id' },
        },
        required: ['statement', 'problem', 'method'],
      },
    },
    async handler(args) {
      const statement = readString(args.statement, 'statement')
      const candidate: IdeaCandidate = {
        // 同一条想法重复打分应得到同一个 id：用 statement 的哈希，而不是随机值或自增。
        idea_id: typeof args.idea_id === 'string' && args.idea_id.trim() !== ''
          ? args.idea_id
          : `mcp-${createHash('sha1').update(statement).digest('hex').slice(0, 12)}`,
        statement,
        problem: readString(args.problem, 'problem'),
        method: readString(args.method, 'method'),
        innovation: typeof args.innovation === 'string' ? args.innovation : '',
        baselines: readStringArray(args.baselines),
      }
      const report = await scorer.score(candidate, kb)
      return jsonResult(report)
    },
  }

  return [kbSearch, kbSummary, ideaScore]
}
