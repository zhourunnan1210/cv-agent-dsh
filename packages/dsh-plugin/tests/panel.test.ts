/**
 * 三专家面板（整合设计 v1.0 §6）的测试。
 *
 * 用**假 subagents** 跑：这一层要证明的是"委派编排 + 分歧处理"的正确性，
 * 不是"LLM 判得准"（后者要靠真实跑批，不是单测能钉的）。
 *
 * 三件事必须钉死：
 * 1. **三位专家并行、互不可见**（首轮 prompt 里不能出现别人的判定）；
 * 2. **讨论轮只跑一轮**，且第二轮能看到彼此理由；
 * 3. **第二轮失败的专家沿用首轮判定**——不能把它踢出去（否则中位数会被少数派重算，
 *    等于"谁失败谁的意见作废"，那是静默的偏置）。
 */
import { describe, expect, it } from 'vitest'

import { runExpertPanel, EXPERT_PERSONAS, coerceExpertVerdict, expertOutputSchema } from '../lib/scoring/panel.js'
import type { ExpertRole } from '@cv-research/core'

const WEIGHTS = { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 }
const BANDS = { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] } as const

/** 一位专家的应答模板。 */
function answer(overrides: Record<string, unknown> = {}) {
  return {
    module_verdicts: [
      { idea_module: '频域一致性约束', status: 'partial', evidence_refs: ['MOD001'], reason: '类似但约束对象不同' },
    ],
    dimension_scores: { novelty_problem: 70, novelty_method: 70, novelty_combo: 70, feasibility: 70 },
    rationale: '总体可做',
    ...overrides,
  }
}

/** 假 subagents：按角色给出脚本化应答，并记录每次委派的 prompt。 */
function makeSubagents(script: Partial<Record<ExpertRole, unknown[]>>) {
  const calls: { label: string; persona?: string; prompt: string }[] = []
  const counters = new Map<ExpertRole, number>()
  const subagents = {
    async start(_name: string, request: Record<string, unknown>) {
      const label = String(request.label)
      const role = label.split(':')[1] as ExpertRole
      const index = counters.get(role) ?? 0
      counters.set(role, index + 1)
      const prompt = (request.prompt as { text: string }[])[0].text
      calls.push({ label, persona: request.persona as string | undefined, prompt })
      const list = script[role] ?? []
      const structured = list[Math.min(index, list.length - 1)] ?? answer()
      return {
        result: Promise.resolve({ structured, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  return { subagents, calls }
}

const baseOptions = {
  ideaId: 'idea-1',
  context: '[候选 idea]\n问题：跨域泛化\n\n[库中候选论文 1 篇]\n── 10.1/a｜Paper A',
  weights: WEIGHTS,
  bands: BANDS,
  agent: { id: 'root' },
  signal: new AbortController().signal,
}

describe('三专家面板', () => {
  it('并行委派三位专家，且首轮 context **不含**任何别人的判定（互不可见）', async () => {
    const { subagents, calls } = makeSubagents({})
    const result = await runExpertPanel(subagents, baseOptions)

    expect(calls, '首轮三位').toHaveLength(3)
    expect(calls.map((call) => call.label).sort()).toEqual(['expert:domain', 'expert:evaluation', 'expert:method'])
    for (const call of calls) {
      expect(call.prompt).toContain('[候选 idea]')
      expect(call.prompt, '首轮不该出现"分歧"字样——那是第二轮才有的').not.toContain('需要你们讨论的分歧点')
    }
    expect(result.discussed).toBe(false)
    expect(result.final).toHaveLength(3)
    expect(result.failed).toEqual([])
  })

  it('每位专家拿到自己的人设（分工互补，不是三个同质评委）', async () => {
    const { subagents, calls } = makeSubagents({})
    await runExpertPanel(subagents, baseOptions)
    const byLabel = Object.fromEntries(calls.map((call) => [call.label, call.persona ?? '']))
    expect(byLabel['expert:method']).toContain('方法/架构专家')
    expect(byLabel['expert:evaluation']).toContain('实验/评测专家')
    expect(byLabel['expert:domain']).toContain('领域/问题专家')
    // 三份人设必须真的不同（否则三倍成本买一份意见）
    expect(new Set(Object.values(EXPERT_PERSONAS)).size).toBe(3)
  })

  it('分歧触发**一轮**讨论：第二轮能看到彼此理由，且只跑一轮', async () => {
    const { subagents, calls } = makeSubagents({
      method: [answer({ dimension_scores: { novelty_problem: 70, novelty_method: 90, novelty_combo: 70, feasibility: 70 } })],
      evaluation: [answer({ dimension_scores: { novelty_problem: 70, novelty_method: 40, novelty_combo: 70, feasibility: 70 } })],
      domain: [answer()],
    })
    const result = await runExpertPanel(subagents, baseOptions)

    expect(result.discussed).toBe(true)
    expect(result.disagreements.map((item) => item.target)).toContain('dimension:novelty_method')
    // 三位各跑两轮 = 6 次委派；**没有第三轮**
    expect(calls).toHaveLength(6)
    expect(calls.filter((call) => call.label.endsWith(':r2'))).toHaveLength(3)
    const secondRound = calls.find((call) => call.label === 'expert:method:r2')
    expect(secondRound?.prompt).toContain('需要你们讨论的分歧点')
    expect(secondRound?.prompt, '要看见别人的理由才谈得上讨论').toContain('evaluation')
  })

  it('讨论后收敛 → resolved_by_discussion；用第二轮分数聚合', async () => {
    const { subagents } = makeSubagents({
      method: [
        answer({ dimension_scores: { novelty_problem: 70, novelty_method: 90, novelty_combo: 70, feasibility: 70 } }),
        answer({ dimension_scores: { novelty_problem: 70, novelty_method: 65, novelty_combo: 70, feasibility: 70 } }),
      ],
      evaluation: [
        answer({ dimension_scores: { novelty_problem: 70, novelty_method: 40, novelty_combo: 70, feasibility: 70 } }),
        answer({ dimension_scores: { novelty_problem: 70, novelty_method: 65, novelty_combo: 70, feasibility: 70 } }),
      ],
      domain: [answer(), answer({ dimension_scores: { novelty_problem: 70, novelty_method: 65, novelty_combo: 70, feasibility: 70 } })],
    })
    const result = await runExpertPanel(subagents, baseOptions)
    expect(result.remaining).toEqual([])
    expect(result.aggregation.disagreement).toBe('resolved_by_discussion')
    expect(result.aggregation.dimensions.novelty_method, '聚合用的是第二轮（65），不是首轮').toBe(65)
    expect(result.initial.map((verdict) => verdict.dimension_scores.novelty_method).sort()).toEqual([40, 70, 90])
  })

  it('讨论后仍分歧 → 标 high（如实暴露，不假装已解决）', async () => {
    const { subagents } = makeSubagents({
      method: [answer({ dimension_scores: { novelty_problem: 70, novelty_method: 95, novelty_combo: 70, feasibility: 70 } })],
      evaluation: [answer({ dimension_scores: { novelty_problem: 70, novelty_method: 20, novelty_combo: 70, feasibility: 70 } })],
      domain: [answer()],
    })
    const result = await runExpertPanel(subagents, baseOptions)
    expect(result.discussed).toBe(true)
    expect(result.remaining.length).toBeGreaterThan(0)
    expect(result.aggregation.disagreement).toBe('high')
  })

  it('**讨论轮失败的专家沿用首轮判定**（不能踢出去，否则中位数被少数派重算）', async () => {
    let domainCalls = 0
    const subagents = {
      async start(_name: string, request: Record<string, unknown>) {
        const role = String(request.label).split(':')[1] as ExpertRole
        if (role === 'domain') {
          domainCalls += 1
          if (domainCalls > 1) return { result: Promise.reject(new Error('第二轮挂了')), dispose: async () => {} }
        }
        const structured = role === 'method'
          ? answer({ dimension_scores: { novelty_problem: 70, novelty_method: 90, novelty_combo: 70, feasibility: 70 } })
          : answer({ dimension_scores: { novelty_problem: 70, novelty_method: 20, novelty_combo: 70, feasibility: 70 } })
        return { result: Promise.resolve({ structured, stopReason: 'completed' }), dispose: async () => {} }
      },
    }
    const result = await runExpertPanel(subagents, { ...baseOptions })
    expect(result.final, '仍是三位——失败者沿用首轮').toHaveLength(3)
    expect(result.failed.some((item) => item.expert === 'domain')).toBe(true)
    expect(result.final.find((verdict) => verdict.expert === 'domain')).toBeDefined()
  })

  it('一位专家失败 → 用剩下两位聚合，并在 failed 里如实报告', async () => {
    const subagents = {
      async start(_name: string, request: Record<string, unknown>) {
        const role = String(request.label).split(':')[1]
        if (role === 'evaluation') {
          return { result: Promise.resolve({ structured: undefined, stopReason: 'error' }), dispose: async () => {} }
        }
        return { result: Promise.resolve({ structured: answer(), stopReason: 'completed' }), dispose: async () => {} }
      },
    }
    const result = await runExpertPanel(subagents, baseOptions)
    expect(result.final).toHaveLength(2)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].expert).toBe('evaluation')
  })

  it('三位全失败 → 明确报错（不能给一份没有推理的报告）', async () => {
    const subagents = {
      async start() {
        return { result: Promise.reject(new Error('服务不可用')), dispose: async () => {} }
      },
    }
    await expect(runExpertPanel(subagents, baseOptions)).rejects.toThrow(/三位专家全部失败/)
  })

  it('形状校验：缺分给中性 50（不是 0 或 100——两者都会歪曲中位数）', () => {
    const verdict = coerceExpertVerdict('method', { module_verdicts: [], rationale: 'x' }, 1)
    expect(verdict.dimension_scores).toEqual({
      novelty_problem: 50, novelty_method: 50, novelty_combo: 50, feasibility: 50,
    })
    const overflow = coerceExpertVerdict('method', {
      module_verdicts: [], dimension_scores: { novelty_method: 999, novelty_problem: -5 }, rationale: 'x',
    }, 1)
    expect(overflow.dimension_scores.novelty_method).toBe(100)
    expect(overflow.dimension_scores.novelty_problem).toBe(0)
  })

  it('形状校验：非法 status 的模块判定被丢弃，整轮不崩', () => {
    const verdict = coerceExpertVerdict('method', {
      module_verdicts: [
        { idea_module: 'A', status: 'known', evidence_refs: ['MOD001'], reason: 'x' },
        { idea_module: 'B', status: 'maybe', evidence_refs: [], reason: 'x' },
        { idea_module: '', status: 'new', evidence_refs: [], reason: 'x' },
      ],
      dimension_scores: {}, rationale: 'x',
    }, 1)
    expect(verdict.module_verdicts.map((item) => item.idea_module)).toEqual(['A'])
  })

  it('outputSchema 与聚合层需要的字段对齐（缺字段会让校验静默降级）', () => {
    const schema = expertOutputSchema()
    expect(schema.required).toEqual(['module_verdicts', 'dimension_scores', 'rationale'])
    expect(Object.keys(schema.properties.dimension_scores.properties).sort()).toEqual(
      ['feasibility', 'novelty_combo', 'novelty_method', 'novelty_problem'],
    )
  })
})
