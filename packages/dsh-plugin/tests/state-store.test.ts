/**
 * S6 gate 形态的 L1 实证：三段式门控的完整往返（真实文件 I/O）。
 *
 * ## 这个测试把两层合起来验证
 *
 * 勘误 §4.3 的三段式门控被拆在两层实现：
 *
 * | 步骤 | 实现层 | 内容 |
 * | --- | --- | --- |
 * | ① 判定并落盘 | core 纯函数 `requestGate` + 本层 `save` | 校验完成判据，写待决 gate |
 * | ② 呈递 | **dsh 侧**（`ask_user_question`） | 本测试不覆盖，见文末说明 |
 * | ③ 决议落盘并推进 | core 纯函数 `resolveGate` + 本层 `save` | 落盘决议，按模式决定是否推进 |
 *
 * 本测试用**真实磁盘**跑通 ① 与 ③ 的完整往返，包括快照与回滚——即
 * v1.2 §9.1 需要的「可持久化、可回滚、可跨会话恢复」三件事。
 *
 * ## 未覆盖的部分（诚实声明）
 *
 * 第 ② 步「向用户呈递并等待答复」无法在此验证：它依赖 dsh 的
 * `ask_user_question` 工具与真实会话循环。本测试只证明：**在②发生前后，
 * 状态机在磁盘上的表现是正确且可恢复的**。②本身的行为仍需端到端实跑
 * （勘误 §5.5）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createProjectState,
  requestGate,
  requiresHumanDecision,
  resolveGate,
  type GateCriteria,
  type ProjectState,
  type Stage,
} from '@cv-research/core'
import { createFileStateStore, stateExists, statePaths } from '../lib/state/store.js'

const NOW = '2026-09-15T10:00:00Z'
const LATER = '2026-09-15T11:00:00Z'

/** 判据：知识构建阶段的论文数需达 100（从阶段记录的 summary 里读）。 */
const hundredPapers: GateCriteria = {
  evaluate: (state) => {
    const summary = state.stages.knowledge_building?.summary ?? ''
    const match = /papers=(\d+)/.exec(summary)
    const count = match === null ? 0 : Number(match[1])
    return count >= 100 ? [] : [`论文数 ${count} 未达 100`]
  },
}

describe('S6：门控状态的真实文件往返', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-state-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const layout = () => ({ projectDir: dir })

  it('全新项目：状态文件不存在，读取返回 undefined', async () => {
    expect(await stateExists(layout())).toBe(false)
    expect(await createFileStateStore(layout()).load()).toBeUndefined()
  })

  it('完整往返：创建 → 落盘 → 读回 → 判定 → 决议 → 推进', async () => {
    const store = createFileStateStore(layout())

    // ── 项目起步：模式未定（勘误 §4.3：由 dsh 侧问一次后落盘）──
    const initial = createProjectState('deepfake-001', null)
    expect(initial.mode).toBeNull()
    expect(requiresHumanDecision(initial.mode)).toBe(true)
    await store.save(initial)
    expect(await stateExists(layout())).toBe(true)

    const reloaded = await store.load()
    expect(reloaded).toEqual(initial)

    // ── 用户选定确认模式后落盘 ──
    const withMode: ProjectState = { ...reloaded!, mode: 'confirm', stages: { knowledge_building: { status: 'in_progress', summary: 'papers=156' } } }
    await store.save(withMode)

    // ── ① 判定阶段出口：达标 → 产生待决 gate ──
    const decision = requestGate(await store.load() as ProjectState, hundredPapers, NOW, '知识构建完成，三库已建')
    expect(decision.satisfied).toBe(true)
    expect(decision.gate).not.toBeNull()

    const gated: ProjectState = { ...withMode, pending_gate: decision.gate }
    await store.save(gated)

    // 磁盘上确实是待决态
    const onDisk = JSON.parse(await readFile(statePaths(layout()).statePath, 'utf8'))
    expect(onDisk.pending_gate.stage).toBe('knowledge_building')

    // ── 阶段完成时生成快照（v1.2 §9.1：每阶段完成自动快照）──
    const point = await store.snapshot('knowledge_building')
    expect(point).toBe('after_knowledge_building')
    expect(await store.listSnapshots()).toEqual(['after_knowledge_building'])

    // ── ③ 用户答复「advance」→ 落盘决议并推进 ──
    const advanced = resolveGate(gated, 'advance', '同意进入 Idea 生成', LATER)
    await store.save(advanced)

    const afterAdvance = (await store.load())!
    expect(afterAdvance.current_stage).toBe('idea_generation')
    expect(afterAdvance.pending_gate).toBeNull()
    expect(afterAdvance.rollback_points).toEqual(['after_knowledge_building'])
    expect(afterAdvance.resolved_gates).toHaveLength(1)
    expect(afterAdvance.resolved_gates[0]).toMatchObject({ decision: 'advance', advanced: true })
    expect(afterAdvance.stages.knowledge_building?.status).toBe('completed')
  })

  it('回滚：恢复快照后状态回到该阶段完成时的样子', async () => {
    const store = createFileStateStore(layout())
    const base = createProjectState('p-002', 'supervised')
    const withProgress: ProjectState = {
      ...base,
      stages: { knowledge_building: { status: 'in_progress', summary: 'papers=156' } },
    }
    await store.save(withProgress)
    await store.snapshot('knowledge_building')

    // 推进到下一阶段并继续做了一些事
    const decision = requestGate(withProgress, hundredPapers, NOW, '完成')
    const gated: ProjectState = { ...withProgress, pending_gate: decision.gate }
    await store.save(resolveGate(gated, 'advance', undefined, LATER))
    expect((await store.load())!.current_stage).toBe('idea_generation')

    // 回滚
    const restored = await store.restore('after_knowledge_building')
    expect(restored.current_stage).toBe('knowledge_building')
    expect(restored.stages.knowledge_building?.status).toBe('in_progress')
    // 磁盘也被覆盖回快照态
    expect((await store.load())!.current_stage).toBe('knowledge_building')
  })

  it('回滚到不存在的快照时报错并列出可用快照', async () => {
    const store = createFileStateStore(layout())
    await store.save(createProjectState('p-003', 'confirm'))
    await expect(store.restore('after_experiment')).rejects.toThrow(
      '快照 after_experiment 不存在；可用快照：(无)',
    )
  })

  it('形状非法的状态文件被拒绝，且与「文件不存在」区分开', async () => {
    const store = createFileStateStore(layout())
    const { statePath } = statePaths(layout())
    // 缺 mode / pending_gate / resolved_gates 等必需字段
    await writeFile(statePath, JSON.stringify({ project_id: 'x', current_stage: 'writing' }), 'utf8')
    await expect(store.load()).rejects.toThrow(/形状非法/)
    await expect(store.load()).rejects.toThrow(/mode 字段缺失/)
  })

  it('半截 JSON 被拒绝（不会静默当成空状态）', async () => {
    const store = createFileStateStore(layout())
    const { statePath } = statePaths(layout())
    await writeFile(statePath, '{"project_id": "x", "current_st', 'utf8')
    await expect(store.load()).rejects.toThrow(/解析失败/)
  })

  it('原子写：覆盖保存后不残留 .tmp 文件', async () => {
    const store = createFileStateStore(layout())
    await store.save(createProjectState('p-004', 'confirm'))
    await store.save(createProjectState('p-004', 'full_auto'))
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    expect(entries.filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect((await store.load())!.mode).toBe('full_auto')
  })

  it('revise 决议不推进阶段，但决议被持久化留痕', async () => {
    const store = createFileStateStore(layout())
    const state: ProjectState = {
      ...createProjectState('p-005', 'confirm'),
      stages: { knowledge_building: { status: 'in_progress', summary: 'papers=156' } },
    }
    const decision = requestGate(state, hundredPapers, NOW, '完成')
    const gated: ProjectState = { ...state, pending_gate: decision.gate }
    await store.save(resolveGate(gated, 'revise', '换个检索子主题', LATER))

    const after = (await store.load())!
    expect(after.current_stage).toBe('knowledge_building')
    expect(after.pending_gate).toBeNull()
    expect(after.rollback_points).toEqual([])
    expect(after.resolved_gates[0]).toMatchObject({ decision: 'revise', comment: '换个检索子主题' })
  })

  it('跨会话恢复：新 store 实例读同一目录得到等价状态', async () => {
    const first = createFileStateStore(layout())
    const state = createProjectState('p-006', 'supervised')
    await first.save(state)
    // 模拟另一个进程/会话打开同一个项目
    const second = createFileStateStore(layout())
    expect(await second.load()).toEqual(state)
  })

  it('阶段参数化：每个阶段都能生成并列出各自的快照', async () => {
    const store = createFileStateStore(layout())
    await store.save(createProjectState('p-007', 'confirm'))
    const stages: Stage[] = ['knowledge_building', 'idea_generation', 'idea_scoring']
    for (const stage of stages) await store.snapshot(stage)
    expect(await store.listSnapshots()).toEqual([
      'after_idea_generation',
      'after_idea_scoring',
      'after_knowledge_building',
    ])
  })
})
