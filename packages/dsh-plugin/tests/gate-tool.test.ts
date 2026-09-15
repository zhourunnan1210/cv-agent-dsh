/**
 * S6 gate 形态的端到端实证：**真实工具执行管线 + 真实文件 I/O**。
 *
 * ## 与 state-store.test.ts 的分工
 *
 * - `state-store.test.ts` 测的是状态层：core 纯函数 + 文件往返。
 * - 本测试测的是**工具层**：参数校验、output schema 校验、execute 管线、
 *   失败结果的形状——全部走真实 `ToolRuntime.execute()`，不是直接调函数。
 *
 * 两者合起来覆盖勘误 §4.3 三段式门控在**主 Agent 侧**的全部机制：
 *
 * | 步骤 | 覆盖位置 |
 * | --- | --- |
 * | ① 判定并落盘 | `cvagent_state_advance` 工具（本测试）→ core 纯函数 + store |
 * | ② 呈递 | **不覆盖**：需真实会话的 `ask_user_question`（勘误 §5.5） |
 * | ③ 决议落盘并推进 | `cvagent_gate_resolve` 工具（本测试） |
 *
 * ## 为什么这一步值得单独测
 *
 * 「工具能被注册」与「工具被模型调用时行为正确」是两件事。前者 S1/names 测试
 * 已覆盖；后者涉及参数校验、值 schema 校验、承诺失败时的 isError 形状——
 * 这些是模型真正感知到的接口。后者出错时，Agent 会看到无法理解的结果。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import {
  createProjectState,
  resolveGate,
  type ProjectState,
} from '@cv-research/core'
import { createFileStateStore, statePaths } from '../lib/state/store.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

/**
 * 每个测试用独立的真实 ToolRuntime。
 *
 * 形态要点（由 probe-cordis.test.ts 实测确认）：
 * - `dsh-system-prompt` 的 default 导出是**插件类**，必须直接传给 `ctx.plugin()`；
 *   把它拆成 `{ name, apply }` 普通对象会被 cordis 拒绝。
 * - 嵌套插件要在父插件的 `apply` 内 **await**，否则子插件尚未激活就返回，
 *   外部读到的 runtime 是 undefined。
 */
async function makeRuntime() {
  const app = new cordis.Context()
  let runtime
  await app.plugin({
    name: 'gate-host',
    async apply(ctx) {
      await ctx.plugin(systemPromptModule.default)
      await ctx.plugin({
        name: 'gate-tools',
        inject: ['systemPrompt'],
        apply(toolsCtx) {
          runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
        },
      })
    },
  })
  if (runtime === undefined) throw new Error('ToolRuntime 未能挂载：systemPrompt 或 tools 服务未就绪')
  return runtime
}

/** 构造一个执行上下文；callId 由调用方给出以便定位。 */
let callSeq = 0
function execInput(name, args) {
  return {
    callId: `call-${++callSeq}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  }
}

/** 注册两个贴近生产的门控工具，落盘走真实文件。 */
function registerGateTools(runtime, store) {
  runtime.register(
    tools.defineTool({
      name: 'cvagent_state_get',
      description: '读取 project_state.json',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const state = await store.load()
        return state === undefined ? '{"exists":false}' : JSON.stringify(state)
      },
    }),
  )

  runtime.register(
    tools.defineTool({
      name: 'cvagent_gate_resolve',
      description: '落盘 gate 决议并推进',
      parameters: {
        decision: { type: 'string', required: true, description: 'advance | revise | rollback' },
        comment: { type: 'string', description: '可选说明' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const { resolveGate } = await import('@cv-research/core')
        const state = await store.load()
        if (state === undefined) throw new Error('project_state.json 不存在')
        const next = resolveGate(state, args.decision, args.comment, '2026-09-15T11:00:00Z')
        await store.save(next)
        return JSON.stringify({ current_stage: next.current_stage, advanced: args.decision === 'advance' })
      },
    }),
  )
}

describe('S6 端到端：门控工具经真实执行管线落盘', () => {
  let dir: string
  let runtime

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-gate-'))
    runtime = await makeRuntime()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('cvagent_state_get 在项目未开始时如实回报 exists:false', async () => {
    const store = createFileStateStore({ projectDir: dir })
    registerGateTools(runtime, store)

    const result = await runtime.execute(execInput('cvagent_state_get', {}))
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.value)).toEqual({ exists: false })
  })

  it('完整门控往返：读状态 → 决议 → 落盘推进，均经工具执行管线', async () => {
    const store = createFileStateStore({ projectDir: dir })
    registerGateTools(runtime, store)

    // 准备一个待决 gate 的状态
    const gated: ProjectState = {
      ...createProjectState('p-gate', 'confirm'),
      stages: { knowledge_building: { status: 'awaiting_gate', summary: 'papers=156' } },
      pending_gate: {
        stage: 'knowledge_building',
        summary: '知识构建完成',
        options: ['advance', 'revise', 'rollback'],
        requested_at: '2026-09-15T10:00:00Z',
      },
    }
    await store.save(gated)

    const resolved = await runtime.execute(
      execInput('cvagent_gate_resolve', { decision: 'advance', comment: '同意' }),
    )
    expect(resolved.isError).toBe(false)
    expect(JSON.parse(resolved.value)).toEqual({ current_stage: 'idea_generation', advanced: true })

    // 磁盘上确实推进了，且决议被留痕
    const onDisk = JSON.parse(await readFile(statePaths({ projectDir: dir }).statePath, 'utf8'))
    expect(onDisk.current_stage).toBe('idea_generation')
    expect(onDisk.pending_gate).toBeNull()
    expect(onDisk.resolved_gates[0]).toMatchObject({ decision: 'advance', comment: '同意', advanced: true })
  })

  it('缺必填参数时被参数校验拦下，返回 isError 而非抛异常', async () => {
    const store = createFileStateStore({ projectDir: dir })
    registerGateTools(runtime, store)

    const result = await runtime.execute(execInput('cvagent_gate_resolve', {}))
    expect(result.isError).toBe(true)
    // 模型能看到的是「哪个参数不合法」，而不是一段堆栈
    expect(JSON.stringify(result.content)).toMatch(/decision/)
  })

  it('工具内部抛错时返回 isError，且错误信息可读', async () => {
    const store = createFileStateStore({ projectDir: dir })
    registerGateTools(runtime, store)

    // 没有状态文件时调用决议工具 → 工具内抛错
    const result = await runtime.execute(execInput('cvagent_gate_resolve', { decision: 'advance' }))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/project_state\.json 不存在/)
  })

  it('无待决 gate 时工具拒绝推进（core 语义边界经工具层透出）', async () => {
    const store = createFileStateStore({ projectDir: dir })
    registerGateTools(runtime, store)

    // 状态存在但没有待决 gate
    await store.save(createProjectState('p-nogate', 'confirm'))

    const result = await runtime.execute(execInput('cvagent_gate_resolve', { decision: 'advance' }))
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/没有待决 gate/)
    // 且状态未被改动
    const onDisk = JSON.parse(await readFile(statePaths({ projectDir: dir }).statePath, 'utf8'))
    expect(onDisk.current_stage).toBe('knowledge_building')
    expect(onDisk.resolved_gates).toEqual([])
  })

  it('core 的 resolveGate 对无 gate 状态直接抛错（不经工具层的语义验证）', () => {
    expect(() => resolveGate(createProjectState('p-x', 'confirm'), 'advance', undefined, '2026-09-15T11:00:00Z')).toThrow(
      /没有待决 gate/,
    )
  })
})
