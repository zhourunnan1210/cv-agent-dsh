/**
 * MCP 工具层测试（Spike S5）：三个工具对着 core 的两个契约跑。
 *
 * 用的是**假实现**（core 接口的最小替身），因为这一层要证明的是
 * 「工具把 core 契约正确地翻译成 MCP 结果」，而不是"sqlite 查得对"——
 * 后者由 dsh-plugin 的 kb 测试负责。
 *
 * 重点断言三件事：
 * 1. **降级标记原样透出**（`mode: keyword_only` 不能被吞，v1.2 §19）；
 * 2. 入参校验失败时给出可读懂的错误（MCP 客户端要能自己改）；
 * 3. 工具只调 core 契约里**存在**的方法（`KnowledgeBase` / `IdeaScorer`）。
 */
import { describe, expect, it } from 'vitest'

import type {
  FailureEntry,
  IdeaCandidate,
  IdeaScorer,
  KnowledgeBase,
  KbSummary,
  MethodEntry,
  ProblemEntry,
  RetrievalResult,
  ScoringReport,
} from '@cv-research/core'

import { createTools } from '../src/tools.js'
import { MCP_SERVER_IDENTITY, createMcpServer } from '../src/server.js'
import { handleMessage } from '../src/protocol.js'

function problem(id: string, statement: string, score: number): { entry: ProblemEntry; score: number } {
  return {
    entry: { entry_id: id, statement, source_papers: ['10.1/x'], ext: {} } as ProblemEntry,
    score,
  }
}

function method(id: string, statement: string, score: number): { entry: MethodEntry; score: number } {
  return {
    entry: { entry_id: id, statement, source_papers: ['10.1/y'], ext: {} } as MethodEntry,
    score,
  }
}

function failure(id: string, statement: string, score: number): { entry: FailureEntry; score: number } {
  return {
    entry: { entry_id: id, statement, source_papers: ['10.1/z'], ext: {} } as FailureEntry,
    score,
  }
}

/** 记录调用参数的假知识库。 */
function fakeKb(overrides: Partial<KnowledgeBase> = {}) {
  const calls: Record<string, unknown[]> = { similarProblems: [], similarMethods: [], similarFailures: [], summarize: [] }
  const kb: KnowledgeBase = {
    upsertProblem: async () => { throw new Error('not used') },
    upsertMethod: async () => { throw new Error('not used') },
    upsertInnovation: async () => { throw new Error('not used') },
    upsertFailure: async () => { throw new Error('not used') },
    similarProblems: async (query, k): Promise<RetrievalResult<ProblemEntry>> => {
      calls.similarProblems.push([query, k])
      return { mode: 'keyword_only', hits: [problem('P001', '跨数据集泛化差', 0.42)] }
    },
    similarMethods: async (query, k): Promise<RetrievalResult<MethodEntry>> => {
      calls.similarMethods.push([query, k])
      return { mode: 'keyword_only', hits: [method('M001', '多尺度融合', 0.31)] }
    },
    similarFailures: async (query, k): Promise<RetrievalResult<FailureEntry>> => {
      calls.similarFailures.push([query, k])
      return { mode: 'keyword_only', hits: [failure('F001', '小样本下该损失不收敛', 0.28)] }
    },
    summarize: async (limit): Promise<KbSummary> => {
      calls.summarize.push([limit])
      return {
        counts: { problems: 14, methods: 21, innovations: 69, failures: 67 },
        problems: [problem('P001', '跨数据集泛化差', 0).entry],
        methods: [method('M001', '多尺度融合', 0).entry],
        innovations: [],
        failures: [failure('F001', '小样本不收敛', 0).entry],
      }
    },
    ...overrides,
  }
  return { kb, calls }
}

const FAKE_SCORER: IdeaScorer = {
  async score(idea: IdeaCandidate): Promise<ScoringReport> {
    return {
      idea_id: idea.idea_id,
      total: 71.5,
      dimensions: { novelty: 20, feasibility: 18, impact: 19, evidence: 14.5 },
      dimension_trace: [],
      evidence: { retrieval_mode: 'keyword_only', collisions: [], failure_hits: [] },
      weights_snapshot: { novelty: 30, feasibility: 30, impact: 25, evidence: 15 },
      band: 'promising',
      risk_level: 'low',
      suggestion: 'proceed',
      escalated_external: false,
      failure_blocked_by: [],
      failure_waivers: [],
      report_consistent: true,
    } as unknown as ScoringReport
  },
}

async function callTool(tools: ReturnType<typeof createTools>, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ kb: fakeKb().kb, scorer: FAKE_SCORER, tools })
  const reply = await handleMessage(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    server.context,
  )
  const response = JSON.parse(reply as string) as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown }
  return response
}

describe('MCP 工具层', () => {
  it('kb_search：缺省查 problems + methods，且**降级标记随结果透出**', async () => {
    const { kb, calls } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    const response = await callTool(tools, 'kb_search', { query: '跨生成器泛化' })

    expect(response.error).toBeUndefined()
    const payload = JSON.parse(response.result?.content[0].text ?? '{}')
    expect(payload.limit).toBe(5)
    expect(payload.results.map((item: { store: string }) => item.store)).toEqual(['problems', 'methods'])
    for (const item of payload.results) {
      expect(item.mode, '降级标记必须透出（v1.2 §19）：客户端要能判断结论可信度').toBe('keyword_only')
      expect(item.hits[0]).toMatchObject({ entry_id: expect.any(String), source_papers: expect.any(Array), score: expect.any(Number) })
    }
    expect(calls.similarProblems).toEqual([['跨生成器泛化', 5]])
    expect(calls.similarMethods).toEqual([['跨生成器泛化', 5]])
  })

  it('kb_search：可指定库与条数；failures 走 similarFailures', async () => {
    const { kb, calls } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    const response = await callTool(tools, 'kb_search', { query: 'q', stores: ['failures'], limit: 3 })
    const payload = JSON.parse(response.result?.content[0].text ?? '{}')
    expect(payload.results).toHaveLength(1)
    expect(payload.results[0].store).toBe('failures')
    expect(calls.similarFailures).toEqual([['q', 3]])
    expect(calls.similarProblems).toEqual([])
  })

  it('kb_search：limit 被夹在 1–50', async () => {
    const { kb, calls } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    await callTool(tools, 'kb_search', { query: 'q', limit: 999 })
    expect(calls.similarProblems).toEqual([['q', 50]])
    await callTool(tools, 'kb_search', { query: 'q', limit: -4 })
    expect(calls.similarProblems[1]).toEqual(['q', 1])
  })

  it('kb_search：未知库名与空 query → isError 文本（客户端能自己改）', async () => {
    const { kb } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    const bad = await callTool(tools, 'kb_search', { query: 'q', stores: ['nope'] })
    expect(bad.result?.isError).toBe(true)
    expect(bad.result?.content[0].text).toContain('未知的库名')
    const empty = await callTool(tools, 'kb_search', { query: '   ' })
    expect(empty.result?.isError).toBe(true)
    expect(empty.result?.content[0].text).toContain('query')
  })

  it('kb_summary：四库计数 + 代表条目（只给 id 与 statement，控上下文）', async () => {
    const { kb, calls } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    const response = await callTool(tools, 'kb_summary', { limit: 2 })
    const payload = JSON.parse(response.result?.content[0].text ?? '{}')
    expect(payload.counts).toMatchObject({ problems: 14, failures: 67 })
    expect(payload.problems[0]).toEqual({ entry_id: 'P001', statement: '跨数据集泛化差' })
    expect(calls.summarize).toEqual([[2]])
  })

  it('idea_score：注入的 scorer 收到完整 IdeaCandidate（core 的必填字段都有值）', async () => {
    const { kb } = fakeKb()
    let seen: IdeaCandidate | undefined
    const scorer: IdeaScorer = {
      async score(idea) {
        seen = idea
        return FAKE_SCORER.score(idea, kb)
      },
    }
    const tools = createTools({ kb, scorer })
    const response = await callTool(tools, 'idea_score', { statement: '想法', problem: '问题', method: '方法' })
    const payload = JSON.parse(response.result?.content[0].text ?? '{}')

    expect(seen).toMatchObject({ statement: '想法', problem: '问题', method: '方法', innovation: '', baselines: [] })
    // 未给 idea_id 时按 statement 哈希生成 → 同文同 id（可复现，便于审计）
    expect(seen?.idea_id).toMatch(/^mcp-[0-9a-f]{12}$/)
    expect(payload.total).toBe(71.5)
    expect(payload.retrieval_mode ?? payload.evidence?.retrieval_mode).toBe('keyword_only')
  })

  it('idea_score：缺必填参数 → isError 指出是哪一个', async () => {
    const { kb } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    const response = await callTool(tools, 'idea_score', { statement: '只有想法' })
    expect(response.result?.isError).toBe(true)
    expect(response.result?.content[0].text).toContain('problem')
  })

  it('工具表就是 S5 计划的那三个能力（名字与 core 契约对应）', () => {
    const { kb } = fakeKb()
    const tools = createTools({ kb, scorer: FAKE_SCORER })
    expect(tools.map((tool) => tool.definition.name)).toEqual(['kb_search', 'kb_summary', 'idea_score'])
    // knowledgebase 的方法在 tools.ts 里是 switch 分派的：core 加库不改这里也不会静默漏
    expect(tools[0].definition.inputSchema).toMatchObject({ required: ['query'] })
  })

  it('服务端身份：客户端 initialize 时看到的 name/version 固定', () => {
    const { kb } = fakeKb()
    const server = createMcpServer({ kb, scorer: FAKE_SCORER })
    expect(server.context.serverInfo).toEqual(MCP_SERVER_IDENTITY)
    expect(server.context.tools).toHaveLength(3)
  })
})
