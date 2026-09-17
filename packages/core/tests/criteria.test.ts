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
      '结构化提取（抽检口径） 1/20 篇',
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

/**
 * 口径基线（方案 C，用户 2026-09-17 裁定）。
 *
 * 场景就是真实的：库里已有 390 篇 / 171 条（上一个课题的存量），新课题要在这份语料上继续。
 * 若判据读绝对总量，"知识建成"当场达标——门控形同虚设。基线把判据改成"本课题新增"。
 */
describe('口径基线（换课题后只认新增）', () => {
  const EXISTING = { papers: 390, parsed: 154, extractions: 21, entries: { problems: 14, methods: 21, innovations: 69, failures: 67 } }

  it('范围变化时记录基线；重复落盘同一范围不动它', () => {
    const base = createProjectState('p1', 'confirm')
    const first = setResearchScope(base, { sub_domain: '跨生成器泛化', keywords: ['cross-generator'] }, '2026-09-17T10:00:00Z', () => EXISTING)
    expect(first.scope_baseline).toMatchObject({ recorded_at: '2026-09-17T10:00:00Z', papers: 390, sub_domain: '跨生成器泛化' })

    // 同一范围再落盘一次：基线必须原样保留（否则每次 scope_set 都把进度清零）
    let snapshotCalls = 0
    const again = setResearchScope(first, { sub_domain: '跨生成器泛化', keywords: ['cross-generator'] }, '2026-09-17T11:00:00Z', () => {
      snapshotCalls += 1
      return { papers: 999, parsed: 999, extractions: 999, entries: {} }
    })
    expect(again.scope_baseline).toEqual(first.scope_baseline)
    expect(snapshotCalls, '范围没变就不该去查库').toBe(0)
  })

  it('存量顶满也不再放行：判据看的是新增', () => {
    const state = setResearchScope(
      { ...createProjectState('p1', 'confirm'), current_stage: 'knowledge_building' },
      { sub_domain: '跨生成器泛化' },
      '2026-09-17T10:00:00Z',
      () => EXISTING,
    )
    // 当前事实 == 基线（一篇没新增）→ 全部不达标，且消息里带存量与基线
    const missing = evaluateCriteria(state, { ...EXISTING, entries: { ...EXISTING.entries } })
    expect(missing).toHaveLength(7)
    expect(missing[0]).toBe('论文库新增 0/100 篇（存量 390，基线 390）')

    // 存量顶满、新增为零 → 七项全部不达标（这正是方案 C 要拦的：绝对口径下这里会直接放行）
    expect(missing).toEqual([
      '论文库新增 0/100 篇（存量 390，基线 390）',
      '已解析全文新增 0/50 篇（存量 154，基线 154）',
      '结构化提取（抽检口径）新增 0/20 篇（存量 21，基线 21）',
      '问题卡新增 0/5 条（存量 14，基线 14）',
      '方法卡新增 0/5 条（存量 21，基线 21）',
      '创新卡新增 0/10 条（存量 69，基线 69）',
      '失败方法库新增 0/5 条（存量 67，基线 67）',
    ])

    // 新增达标（只靠新增，不靠存量）
    const grown: StageFacts = {
      papers: 390 + 100,
      parsed: 154 + 50,
      extractions: 21 + 20,
      entries: { problems: 14 + 5, methods: 21 + 5, innovations: 69 + 10, failures: 67 + 5 },
    }
    expect(evaluateCriteria(state, grown)).toEqual([])

    // 只新增一点点：报"新增 5/100"，不被 395 的存量掩盖；其余六项仍点名
    const barely = evaluateCriteria(state, { ...EXISTING, papers: 395, entries: { ...EXISTING.entries } })
    expect(barely[0]).toBe('论文库新增 5/100 篇（存量 395，基线 390）')
    expect(barely).toHaveLength(7)
    expect(barely).toContain('已解析全文新增 0/50 篇（存量 154，基线 154）')
  })

  it('没有基线时退回绝对口径（新项目行为不变）', () => {
    const state = withStage('knowledge_building', { sub_domain: '音频深伪检测' })
    expect(state.scope_baseline ?? null).toBeNull()
    expect(evaluateCriteria(state, RICH_FACTS)).toEqual([])
  })

  it('换课题会重新记基线（旧基线不跨课题生效）', () => {
    const first = setResearchScope(
      { ...createProjectState('p1', 'confirm'), current_stage: 'knowledge_building' },
      { sub_domain: '课题一' },
      '2026-09-17T10:00:00Z',
      () => EXISTING,
    )
    const second = setResearchScope(first, { sub_domain: '课题二' }, '2026-09-18T10:00:00Z', () => ({ ...EXISTING, papers: 500 }))
    expect(second.scope_baseline).toMatchObject({ sub_domain: '课题二', papers: 500, recorded_at: '2026-09-18T10:00:00Z' })
    expect(evaluateCriteria(second, { ...EXISTING, papers: 500, entries: { ...EXISTING.entries } })[0])
      .toBe('论文库新增 0/100 篇（存量 500，基线 500）')
  })

  /**
   * 升级路径：老状态（范围早已落盘、没有基线字段）必须**补记基线**而不是继续用绝对口径。
   * 这正是用户当前那条状态的真实形态。
   */
  it('老状态（无基线字段）：再落一次同一范围也会补记基线', () => {
    // 模拟升级前的状态：sub_domain 已落盘，但完全没有 scope_baseline 字段
    const legacy: ProjectState = { ...createProjectState('p1', 'confirm'), current_stage: 'knowledge_building', sub_domain: '跨生成器泛化', keywords: ['cross-generator'] }
    expect(legacy.scope_baseline).toBeUndefined()
    // 升级后第一次 advance：明确卡住，要求补记（不误放）
    expect(evaluateCriteria(legacy, { ...EXISTING, entries: { ...EXISTING.entries } }))
      .toContain('口径基线未记录（本状态由升级前写入）：再调一次 cvagent_scope_set（含本课题范围）以在现有存量上划出起点')

    // 再落一次**同一范围** → 补记基线（changed=false，但缺字段）
    const migrated = setResearchScope(legacy, { sub_domain: '跨生成器泛化', keywords: ['cross-generator'] }, '2026-09-17T12:00:00Z', () => EXISTING)
    expect(migrated.scope_baseline).toMatchObject({ papers: 390, recorded_at: '2026-09-17T12:00:00Z' })
    const after = evaluateCriteria(migrated, { ...EXISTING, entries: { ...EXISTING.entries } })
    expect(after).not.toContain('口径基线未记录（本状态由升级前写入）：再调一次 cvagent_scope_set（含本课题范围）以在现有存量上划出起点')
    expect(after[0]).toBe('论文库新增 0/100 篇（存量 390，基线 390）')

    // 再落第三次：基线已存在 → 不再补记（进度不会被清零）
    const third = setResearchScope(migrated, { sub_domain: '跨生成器泛化', keywords: ['cross-generator'] }, '2026-09-17T13:00:00Z', () => ({ ...EXISTING, papers: 999 }))
    expect(third.scope_baseline).toEqual(migrated.scope_baseline)
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
