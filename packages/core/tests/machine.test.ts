import { describe, expect, it } from 'vitest'

import {
  createProjectState,
  requestGate,
  requiresHumanDecision,
  resolveGate,
  type GateCriteria,
  type ProjectState,
} from '../src/state/machine.js'

const NOW = '2026-09-15T10:00:00Z'

/** 判据：知识构建阶段论文数需达 100。 */
const needsHundredPapers: GateCriteria = {
  evaluate: (state) => {
    const record = state.stages.knowledge_building
    const summary = record?.summary ?? ''
    const match = /papers=(\d+)/.exec(summary)
    const count = match === null ? 0 : Number(match[1])
    return count >= 100 ? [] : [`论文数 ${count} 未达 100`]
  },
}

function stateWithSummary(summary: string): ProjectState {
  const base = createProjectState('p-001', 'confirm')
  return { ...base, stages: { knowledge_building: { status: 'in_progress', summary } } }
}

describe('requestGate（勘误 §4.3 第 ① 步）', () => {
  it('判据未满足时不产生 gate，并回传缺失项', () => {
    const decision = requestGate(stateWithSummary('papers=42'), needsHundredPapers, NOW, '摘要')
    expect(decision.satisfied).toBe(false)
    expect(decision.gate).toBeNull()
    expect(decision.missing).toEqual(['论文数 42 未达 100'])
  })

  it('判据满足时产生待决 gate，且不修改传入状态', () => {
    const state = stateWithSummary('papers=156')
    const snapshot = JSON.stringify(state)
    const decision = requestGate(state, needsHundredPapers, NOW, '知识构建完成')
    expect(decision.satisfied).toBe(true)
    expect(decision.gate?.stage).toBe('knowledge_building')
    expect(decision.gate?.options).toContain('advance')
    // 纯函数：调用方负责落盘，requestGate 不得就地改写
    expect(JSON.stringify(state)).toBe(snapshot)
    expect(state.pending_gate).toBeNull()
  })
})

describe('resolveGate（勘误 §4.3 第 ③ 步）', () => {
  const gated: ProjectState = {
    ...stateWithSummary('papers=156'),
    pending_gate: {
      stage: 'knowledge_building',
      summary: '知识构建完成',
      options: ['advance', 'revise', 'rollback'],
      requested_at: NOW,
    },
  }

  it('advance 推进到下一阶段并写入回滚点', () => {
    const next = resolveGate(gated, 'advance', undefined, NOW)
    expect(next.current_stage).toBe('idea_generation')
    expect(next.stages.knowledge_building?.status).toBe('completed')
    expect(next.stages.knowledge_building?.rollback_point).toBe('after_knowledge_building')
    expect(next.rollback_points).toEqual(['after_knowledge_building'])
    expect(next.pending_gate).toBeNull()
    expect(next.resolved_gates.at(-1)?.advanced).toBe(true)
  })

  it('revise 不推进阶段，只清除 gate 并留痕', () => {
    const next = resolveGate(gated, 'revise', '换个检索子主题', NOW)
    expect(next.current_stage).toBe('knowledge_building')
    expect(next.stages.knowledge_building?.status).toBe('in_progress')
    expect(next.rollback_points).toEqual([])
    expect(next.resolved_gates.at(-1)).toMatchObject({
      decision: 'revise',
      comment: '换个检索子主题',
      advanced: false,
    })
  })

  it('无待决 gate 时抛错，而不是静默推进', () => {
    expect(() => resolveGate(stateWithSummary('papers=156'), 'advance', undefined, NOW)).toThrow(/没有待决 gate/)
  })

  it('已是最后阶段时 advance 停在 writing，不越界', () => {
    const last: ProjectState = {
      ...createProjectState('p-002', 'full_auto'),
      current_stage: 'writing',
      pending_gate: {
        stage: 'writing',
        summary: '材料包与草稿已产出',
        options: ['advance', 'revise'],
        requested_at: NOW,
      },
    }
    const next = resolveGate(last, 'advance', undefined, NOW)
    expect(next.current_stage).toBe('writing')
    expect(next.resolved_gates.at(-1)?.advanced).toBe(true)
  })
})

describe('requiresHumanDecision（勘误 §4.3 模式差异）', () => {
  it('confirm 与未定模式需要人工决议', () => {
    expect(requiresHumanDecision('confirm')).toBe(true)
    // null 保守按 confirm 处理，促使 dsh 侧先询问一次模式
    expect(requiresHumanDecision(null)).toBe(true)
  })

  it('supervised 与 full_auto 不需要', () => {
    expect(requiresHumanDecision('supervised')).toBe(false)
    expect(requiresHumanDecision('full_auto')).toBe(false)
  })
})
