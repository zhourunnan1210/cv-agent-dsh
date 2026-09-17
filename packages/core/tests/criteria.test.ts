/**
 * 阶段判据与研究范围测试（P3-4，`core/src/state/machine.ts`）。
 *
 * 这一层是门控的**真实性**所在：判据吃的是 dsh 侧从知识库读出的真实数字，
 * 不是模型自报。因此测试重点是「数字→缺失清单」的映射与边界。
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CRITERIA,
  createProjectState,
  evaluateCriteria,
  setResearchScope,
  type ProjectState,
  type StageFacts,
} from '../src/state/machine.js'

const RICH_FACTS: StageFacts = {
  papers: 390,
  parsed: 154,
  extractions: 21,
  entries: { problems: 14, methods: 21, innovations: 69, failures: 67 },
  ideas_generated: 4,
  ideas_scored: 2,
  experiments: 1,
}

function withStage(stage: ProjectState['current_stage'], scope: { sub_domain?: string | null; keywords?: readonly string[] } = {}): ProjectState {
  const base = createProjectState('p1', 'confirm')
  return setResearchScope({ ...base, current_stage: stage }, scope)
}

describe('研究范围（sub_domain / keywords）', () => {
  it('初始为空；设置后去空白、去重、保序', () => {
    const initial = createProjectState('p1', null)
    expect(initial.sub_domain).toBeNull()
    expect(initial.keywords).toEqual([])

    const set = setResearchScope(initial, {
      sub_domain: '  音频深伪检测  ',
      keywords: [' audio deepfake ', 'audio deepfake', '', 'ASVspoof'],
    })
    expect(set.sub_domain).toBe('音频深伪检测')
    expect(set.keywords).toEqual(['audio deepfake', 'ASVspoof'])
  })

  it('空串与未设置归一到同一个状态（下游只需判一次 null）', () => {
    const cleared = setResearchScope(createProjectState('p1', null), { sub_domain: '   ' })
    expect(cleared.sub_domain).toBeNull()
    const untouched = setResearchScope(cleared, { keywords: ['x'] })
    expect(untouched.sub_domain).toBeNull() // 不传 sub_domain 时保持原值
  })
})

describe('knowledge_building 判据（真实数字 → 缺失清单）', () => {
  it('数字全部达标但研究范围未定 → 仍不放行', () => {
    const missing = evaluateCriteria(withStage('knowledge_building'), RICH_FACTS)
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatch(/研究范围未确定/)
  })

  it('范围已定 + 数字达标 → 无缺失项', () => {
    const state = withStage('knowledge_building', { sub_domain: '音频深伪检测' })
    expect(evaluateCriteria(state, RICH_FACTS)).toEqual([])
  })

  it('缺什么就说什么（含当前/要求两个数字），且四库分别把关', () => {
    const state = withStage('knowledge_building', { sub_domain: '音频深伪检测' })
    const missing = evaluateCriteria(state, {
      papers: 12,
      parsed: 3,
      extractions: 1,
      entries: { problems: 1, methods: 0, innovations: 2, failures: 0 },
    })
    expect(missing).toEqual([
      '论文库 12/100 篇',
      '已解析全文 3/50 篇',
      '结构化提取（抽检口径）1/20 篇',
      '问题卡 1/5 条',
      '方法卡 0/5 条',
      '创新卡 2/10 条',
      '失败方法库 0/5 条',
    ])
  })

  it('阈值可覆盖（项目可自定下限）', () => {
    const state = withStage('knowledge_building', { sub_domain: 'x' })
    const relaxed = {
      ...DEFAULT_CRITERIA,
      knowledge_building: { min_papers: 1, min_parsed: 1, min_extractions: 1, min_problems: 0, min_methods: 0, min_innovations: 0, min_failures: 0 },
    }
    expect(evaluateCriteria(state, { papers: 1, parsed: 1, extractions: 1, entries: {} }, relaxed)).toEqual([])
  })
})

describe('后续阶段判据', () => {
  it('idea_generation 要求候选数下限', () => {
    const state = withStage('idea_generation', { sub_domain: 'x' })
    expect(evaluateCriteria(state, { ...RICH_FACTS, ideas_generated: 0 })[0]).toMatch(/候选 idea 0\/3/)
    expect(evaluateCriteria(state, { ...RICH_FACTS, ideas_generated: 4 })).toEqual([])
  })

  it('idea_scoring 要求已打分下界', () => {
    const state = withStage('idea_scoring', { sub_domain: 'x' })
    expect(evaluateCriteria(state, { ...RICH_FACTS, ideas_scored: 0 })[0]).toMatch(/已打分 idea 0\/1/)
    expect(evaluateCriteria(state, { ...RICH_FACTS, ideas_scored: 2 })).toEqual([])
  })

  it('experiment 要求至少一个收敛实验', () => {
    const state = withStage('experiment', { sub_domain: 'x' })
    expect(evaluateCriteria(state, { ...RICH_FACTS, experiments: 0 })[0]).toMatch(/已收敛实验 0\/1/)
    expect(evaluateCriteria(state, { ...RICH_FACTS, experiments: 3 })).toEqual([])
  })

  it('writing 阶段不设下限（交付物形态差异太大，交人工门控）', () => {
    const state = withStage('writing', { sub_domain: 'x' })
    expect(evaluateCriteria(state, RICH_FACTS)).toEqual([])
  })
})
