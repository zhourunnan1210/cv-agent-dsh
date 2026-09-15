/**
 * cvagent 状态族工具：真实 ToolRuntime 管线 + 真实文件 I/O。
 *
 * 与已删除的 gate-tool.test.ts 的区别：那个测试注册的是**内联假工具**验证管线
 * 机制；本测试挂载**真实实现**（`cv-agent-dsh/state` 服务 + `cv-agent-dsh/state-tools`
 * 工具行），验证的是 Phase 1 交付物本身。
 *
 * 覆盖：
 * - 5 个工具的参数校验 / output 校验 / isError 形状（真实 execute 管线）
 * - 三段式门控的完整往返、快照与回滚（真实磁盘）
 * - 动态 prompt 章节随阶段/模式变化（勘误 §4.5 的落点）
 * - Phase 1 验收：空流水线在 confirm / supervised / full_auto 三种模式下
 *   五阶段走通并可回滚
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { ProjectStateService } from '../lib/state/service.js'
import * as stateTools from '../lib/state/tools.js'
import { statePaths } from '../lib/state/store.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

/**
 * 挂载一条完整的服务链：systemPrompt → ToolRuntime → projectState → state-tools。
 *
 * 挂载形态要点（probe 诊断 + S1 实证）：
 * - ToolRuntime 与 ProjectStateService 走真实 Service 构造（各自的 ctx）。
 * - 状态族工具行以**直接 apply 调用**挂接：`stateTools.apply({ tools, projectState })`。
 *   原因：把行挂成 cordis 插件时，行 ctx 解析到的 `tools` 是作用域载体而非
 *   ToolRuntime 本体（`register()` 会因 `this.layers` 缺失失败），而本测试的
 *   目标是「工具定义 + 服务逻辑 + 门控全流程」，不是 cordis 注入机制——
 *   注入与作用域装载由隔离 profile 的实机装载验证（§5.4 同款）与
 *   preset mount-validate 覆盖。
 * - 各插件在 app 级顺序挂载并逐个 await；顺序挂载下工具注册进全局层，
 *   execute 不带 agent 即可解析。
 */
async function makeEnv(projectDir) {
  const app = new cordis.Context()
  let runtime
  let service
  let prompt
  await app.plugin({
    name: 'state-host-outer',
    async apply(ctx) {
      await ctx.plugin(systemPromptModule.default)
    },
  })
  await app.plugin({
    name: 'state-host-core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      service = new ProjectStateService(coreCtx, { projectDir })
      prompt = coreCtx.systemPrompt
    },
  })
  // 直接 apply：绕过 cordis 作用域载体，用真实的 runtime 与 service。
  stateTools.apply({ tools: runtime, projectState: service })

  let callSeq = 0
  const execute = (name, args) =>
    runtime.execute({
      callId: `call-${++callSeq}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })

  const section = async (name) => {
    const assembly = await prompt.assemble()
    return assembly.sections.find((s) => s.name === name)?.text
  }

  return { execute, service, section }
}

const STAGES = ['knowledge_building', 'idea_generation', 'idea_scoring', 'experiment'] as const

/** 走完一个阶段的完整门控往返：advance → gate_resolve(advance)。 */
async function walkStage(execute, summary) {
  const advanced = await execute('cvagent_state_advance', { summary })
  expect(advanced.isError).toBe(false)
  expect(advanced.value.satisfied).toBe(true)
  expect(advanced.value.gate_requested).toBe(true)
  const resolved = await execute('cvagent_gate_resolve', { decision: 'advance', comment: `同意（${summary}）` })
  expect(resolved.isError).toBe(false)
  return resolved.value
}

describe('cvagent 状态族工具（真实实现 + 真实管线）', () => {
  let dir
  let env

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-state-tools-'))
    env = await makeEnv(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('全新项目：state_get 报 exists:false，且不创建状态文件', async () => {
    const result = await env.execute('cvagent_state_get', {})
    expect(result.isError).toBe(false)
    expect(result.value.exists).toBe(false)
    expect(result.value.state).toBeUndefined()
    // 读取不该有副作用：项目仍然不存在
    expect(await env.service.getState()).toBeUndefined()
  })

  it('无 config 构造（preset 行不带 config 的场景）：默认值解析完整', async () => {
    // E19 回归测试：preset 组合里 `- id: cvagent-state\n name: cv-agent-dsh/state`
    // 不带 config 时，Loader 传入 undefined。resolveStateConfig 是构造器唯一
    // 依赖的默认值来源，必须对 undefined 给出完整配置。
    const { resolveStateConfig } = await import('../lib/state/service.js')
    expect(resolveStateConfig(undefined)).toEqual({
      projectDir: 'data/projects/default',
      stateFilename: 'project_state.json',
      projectId: 'cv-research-project',
    })
    // 部分配置只覆盖给定字段
    expect(resolveStateConfig({ projectDir: dir })).toMatchObject({
      projectDir: dir,
      projectId: 'cv-research-project',
    })
  })

  it('advance 缺摘要 → 参数校验拦下并返回 isError', async () => {
    const result = await env.execute('cvagent_state_advance', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/summary/)
  })

  it('advance 空摘要 → 判据未满足，返回缺失项清单', async () => {
    const result = await env.execute('cvagent_state_advance', { summary: '   ' })
    expect(result.isError).toBe(false)
    expect(result.value.satisfied).toBe(false)
    expect(result.value.gate_requested).toBe(false)
    expect(result.value.missing.length).toBeGreaterThan(0)
  })

  it('advance 正常摘要 → 写入待决门控；动态章节反映待决状态', async () => {
    await env.execute('cvagent_mode_set', { mode: 'confirm' })
    const result = await env.execute('cvagent_state_advance', { summary: '知识构建完成：papers=156（mock）' })
    expect(result.value.satisfied).toBe(true)
    expect(result.value.gate_requested).toBe(true)

    const text = await env.section('cvagent:state')
    expect(text).toContain('knowledge_building')
    expect(text).toContain('有待决门控')
    expect(text).toContain('ask_user_question') // A 模式必须先问用户
  })

  it('gate_resolve 无待决门控 → isError 且不推进、不改状态', async () => {
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    const result = await env.execute('cvagent_gate_resolve', { decision: 'advance' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/没有待决 gate/)
    const state = await env.service.getState()
    expect(state?.current_stage).toBe('knowledge_building')
    expect(state?.resolved_gates).toEqual([])
  })

  it('完整往返：advance → resolve(advance) → 快照 → 回滚', async () => {
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    await walkStage(env.execute, '知识构建完成（mock）')

    const state = await env.service.getState()
    expect(state?.current_stage).toBe('idea_generation')
    expect(state?.rollback_points).toEqual(['after_knowledge_building'])
    expect(await env.service.listSnapshots()).toEqual(['after_knowledge_building'])

    // 磁盘快照真实存在
    const { readFile } = await import('node:fs/promises')
    const snapshot = JSON.parse(await readFile(join(statePaths({ projectDir: dir }).snapshotRoot, 'after_knowledge_building.json'), 'utf8'))
    expect(snapshot.current_stage).toBe('idea_generation')

    const rollback = await env.execute('cvagent_state_rollback', { point: 'after_knowledge_building' })
    expect(rollback.isError).toBe(false)
    // 快照拍摄的是「推进后」的状态（服务 resolveStageGate 的约定）：
    // 回到 after_knowledge_building = 回到该阶段刚完成、下一阶段待开工的位置。
    expect(rollback.value.restored_stage).toBe('idea_generation')
    expect((await env.service.getState())?.current_stage).toBe('idea_generation')
  })

  it('动态 prompt 章节随阶段推进变化', async () => {
    await env.execute('cvagent_mode_set', { mode: 'supervised' })
    expect(await env.section('cvagent:state')).toContain('knowledge_building')
    await walkStage(env.execute, '知识构建完成（mock）')
    expect(await env.section('cvagent:state')).toContain('idea_generation')
    await walkStage(env.execute, 'Idea 生成完成（mock）')
    expect(await env.section('cvagent:state')).toContain('idea_scoring')
  })

  describe('Phase 1 验收：空流水线三模式走通并可回滚', () => {
    for (const mode of ['confirm', 'supervised', 'full_auto'] as const) {
      it(`模式 ${mode}：五阶段推进到 writing，可回滚`, async () => {
        await env.execute('cvagent_mode_set', { mode })

        for (const stage of STAGES) {
          const resolved = await walkStage(env.execute, `${stage} 完成（mock）`)
          expect(resolved.current_stage).not.toBe(stage)
        }
        // 末阶段（writing）的推进停在 writing，不越界
        const finalAdvance = await walkStage(env.execute, 'writing 完成（mock）')
        expect(finalAdvance.current_stage).toBe('writing')

        const state = await env.service.getState()
        expect(state?.current_stage).toBe('writing')
        expect(state?.rollback_points.length).toBe(STAGES.length + 1)

        // 回滚到第一个回滚点：快照是「推进后」的状态 → 落在 idea_generation
        const rollback = await env.execute('cvagent_state_rollback', { point: 'after_knowledge_building' })
        expect(rollback.value.restored_stage).toBe('idea_generation')

        // 三种模式下动态章节给出的推进指引不同：A 模式要求先问用户
        const text = await env.section('cvagent:state')
        if (mode === 'confirm') expect(text).toContain('ask_user_question')
        else expect(text).not.toContain('必须先经 ask_user_question')
      })
    }
  })
})
