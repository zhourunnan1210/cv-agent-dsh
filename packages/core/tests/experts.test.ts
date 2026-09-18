/**
 * 三专家聚合（整合设计 v1.0 §6）的测试。
 *
 * 这一层是**确定性**的，所以它承载了整条打分链路里所有可验证的规则：
 * 中位数聚合、档位、分歧检测、以及**一致性校验**。
 *
 * 特别要钉住两条设计决定（它们是对旧机制的纠正）：
 * 1. **中位数不用均值**——一个跑偏的专家不该把结论拖走；
 * 2. **矛盾只记录、不改分**——旧机制"撞车维度封顶 20 分"是系统篡改专家判断；
 *    新机制把它换成点名式的校验，分数保持专家所给。
 */
import { describe, expect, it } from 'vitest'

import {
  DIMENSION_KEYS,
  aggregateExperts,
  detectDisagreements,
  median,
  renderDiscussionPrompt,
  type ExpertVerdict,
  type ScoringDimensions,
} from '../src/experts.js'

const WEIGHTS: ScoringDimensions = { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 }
const BANDS = { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] } as const

function scores(partial: Partial<ScoringDimensions>): ScoringDimensions {
  return { novelty_problem: 70, novelty_method: 70, novelty_combo: 70, feasibility: 70, ...partial }
}

function expert(
  role: ExpertVerdict['expert'],
  dimension_scores: ScoringDimensions,
  module_verdicts: ExpertVerdict['module_verdicts'] = [],
  round = 1,
): ExpertVerdict {
  return { expert: role, dimension_scores, module_verdicts, rationale: `${role} 的理由`, round }
}

describe('中位数', () => {
  it('奇数个取中间，偶数个取中间两个均值', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it('不改动传入数组（聚合不该有副作用）', () => {
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('聚合：中位数 + 档位', () => {
  it('三位专家取中位数（**不是均值**——一个跑偏的不该拖走结论）', () => {
    const result = aggregateExperts([
      expert('method', scores({ novelty_method: 90 })),
      expert('evaluation', scores({ novelty_method: 60 })),
      expert('domain', scores({ novelty_method: 20 })),   // 一个极低值
    ], WEIGHTS, BANDS)
    expect(result.dimensions.novelty_method, '中位数 = 60；均值会是 56.7，被那一个极端值拖走').toBe(60)
    expect(result.per_dimension.novelty_method).toEqual([90, 60, 20])
  })

  it('总分 = 加权和；档位按 pack 区间', () => {
    const high = aggregateExperts([expert('method', scores({})), expert('evaluation', scores({})), expert('domain', scores({}))], WEIGHTS, BANDS)
    expect(high.total).toBe(70)
    expect(high.band).toBe('revise')

    const proceed = aggregateExperts([
      expert('method', scores({ novelty_problem: 90, novelty_method: 90, novelty_combo: 90, feasibility: 90 })),
      expert('evaluation', scores({ novelty_problem: 80, novelty_method: 80, novelty_combo: 80, feasibility: 80 })),
      expert('domain', scores({ novelty_problem: 85, novelty_method: 85, novelty_combo: 85, feasibility: 85 })),
    ], WEIGHTS, BANDS)
    expect(proceed.band).toBe('proceed')

    const abandon = aggregateExperts([
      expert('method', scores({ novelty_problem: 10, novelty_method: 10, novelty_combo: 10, feasibility: 10 })),
    ], WEIGHTS, BANDS)
    expect(abandon.band).toBe('abandon')
  })

  it('没有任何专家时明确报错（不能静默给出 0 分报告）', () => {
    expect(() => aggregateExperts([], WEIGHTS, BANDS)).toThrow(/至少要有一位专家/)
  })
})

describe('分歧检测（§6.3 的两个触发条件）', () => {
  it('维度分差 > 阈值即触发（默认 15）', () => {
    const disagreements = detectDisagreements([
      expert('method', scores({ novelty_method: 80 })),
      expert('evaluation', scores({ novelty_method: 60 })),
    ])
    expect(disagreements.map((item) => item.target)).toContain('dimension:novelty_method')
    // 边界：恰好 15 不触发（阈值是"超过"）
    expect(detectDisagreements([
      expert('method', scores({ novelty_method: 75 })),
      expert('evaluation', scores({ novelty_method: 60 })),
    ], 15).map((item) => item.target)).not.toContain('dimension:novelty_method')
  })

  it('同一模块判定不同也触发——**这比分数分歧更值得讨论**', () => {
    const disagreements = detectDisagreements([
      expert('method', scores({}), [{ idea_module: '频域约束', status: 'known', evidence_refs: ['MOD001'], reason: '库里已有' }]),
      expert('domain', scores({}), [{ idea_module: '频域约束', status: 'new', evidence_refs: [], reason: '没找到' }]),
    ])
    const moduleDisagreement = disagreements.find((item) => item.kind === 'module')
    expect(moduleDisagreement?.target).toBe('module:频域约束')
    expect(moduleDisagreement?.positions).toHaveLength(2)
    expect(moduleDisagreement?.positions.map((position) => position.value).sort()).toEqual(['known', 'new'])
  })

  it('一位专家时不可能有分歧（不做无意义的讨论）', () => {
    expect(detectDisagreements([expert('method', scores({}))])).toEqual([])
  })

  it('讨论提示把各方理由摆出来（互见理由才谈得上讨论）', () => {
    const disagreements = detectDisagreements([
      expert('method', scores({ novelty_method: 80 })),
      expert('evaluation', scores({ novelty_method: 40 })),
    ])
    const prompt = renderDiscussionPrompt(disagreements)
    expect(prompt).toContain('需要你们讨论的分歧点')
    expect(prompt).toContain('method')
    expect(prompt).toContain('evaluation')
    expect(prompt).toContain('维持')
    expect(renderDiscussionPrompt([]), '没有分歧就不该有讨论轮').toBe('')
  })
})

describe('一致性校验：只记录，不改分（纠正旧的"撞车封顶 20"）', () => {
  it('判 known 却给高 novelty_method → 点名冲突，但**分数保持专家所给**', () => {
    const verdicts = [
      expert('method', scores({ novelty_method: 88 }), [
        { idea_module: '频域约束', status: 'known', evidence_refs: ['MOD001'], reason: '库里已有' },
      ]),
    ]
    const result = aggregateExperts(verdicts, WEIGHTS, BANDS)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toContain('method')
    expect(result.conflicts[0]).toContain('频域约束')
    expect(result.conflicts[0]).toContain('88')
    // ★ 关键：分数没有被系统改写
    expect(result.dimensions.novelty_method, '系统不得篡改专家判断').toBe(88)
  })

  it('判 known 但分数不高 → 不报冲突（判定与分数一致）', () => {
    const result = aggregateExperts([
      expert('method', scores({ novelty_method: 30 }), [
        { idea_module: '频域约束', status: 'known', evidence_refs: ['MOD001'], reason: '有' },
      ]),
    ], WEIGHTS, BANDS)
    expect(result.conflicts).toEqual([])
  })

  it('给了判定却没有引用 → 记 unsupported（给分必须有依据）', () => {
    const result = aggregateExperts([
      expert('method', scores({}), [
        { idea_module: '原型对齐', status: 'new', evidence_refs: [], reason: '感觉是新的' },
      ]),
    ], WEIGHTS, BANDS)
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]).toContain('原型对齐')
  })
})

describe('分歧标记', () => {
  it('无分歧 → none；讨论后仍有分歧 → high；讨论后收敛 → resolved_by_discussion', () => {
    const verdict = [expert('method', scores({}))]
    expect(aggregateExperts(verdict, WEIGHTS, BANDS).disagreement).toBe('none')
    expect(aggregateExperts(verdict, WEIGHTS, BANDS, { discussed: true }).disagreement).toBe('resolved_by_discussion')
    expect(aggregateExperts(verdict, WEIGHTS, BANDS, {
      discussed: true,
      remainingDisagreements: [{ target: 'dimension:novelty_method', kind: 'dimension', positions: [] }],
    }).disagreement, '讨论后仍分歧要如实标 high，而不是假装已解决').toBe('high')
  })
})

describe('维度键与权重快照同源', () => {
  it('DIMENSION_KEYS 覆盖四维且顺序稳定', () => {
    expect([...DIMENSION_KEYS]).toEqual(['novelty_problem', 'novelty_method', 'novelty_combo', 'feasibility'])
  })
})
