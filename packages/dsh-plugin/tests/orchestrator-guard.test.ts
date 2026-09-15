/**
 * 主编排会话执行级护栏的集成测试（E20 落地）。
 *
 * 用真实 ToolRuntime 的执行管线验证：
 * - 根 agent（主会话）调用被禁工具 → deny，结果 isError 且理由可读；
 * - 根 agent 调用未禁工具 → 正常执行；
 * - 子代理（不在 roots 里）调用被禁工具 → 正常执行（子代理归 toolFilter 管）；
 * - 无 agent 的调用（agentless）→ 护栏不生效（fail-open）；
 * - 自定义 deny 名单覆盖默认名单。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import * as guard from '../lib/state/orchestrator-guard.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

const ROOT = { id: 'session-root-1' }
const CHILD = { id: 'session-child-1' }

function makeTool(name) {
  return tools.defineTool({
    name,
    description: `guard test tool ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async () => `${name} ran`,
  })
}

/** 组装：systemPrompt → ToolRuntime → 假 agents 注册表 → 注册测试工具 → 护栏。 */
async function makeEnv(config) {
  const app = new cordis.Context()
  let runtime
  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
    },
  })
  await app.plugin({
    name: 'fake-agents',
    apply(ctx) {
      ctx.provide('agents', { roots: () => [ROOT] })
    },
  })
  // 直接在真实 runtime 上注册测试工具（全局层）
  runtime.register(makeTool('read_semantic_paper'))
  runtime.register(makeTool('search_papers'))
  // 护栏：直接 apply 到真实 cordis ctx（真实事件注册）
  await app.plugin({
    name: 'cvagent-orchestrator-guard',
    inject: ['tools'],
    apply: (guardCtx) => guard.apply(guardCtx, config),
  })

  let seq = 0
  const execute = (name, agent) =>
    runtime.execute({
      callId: `call-${++seq}`,
      name,
      arguments: {},
      signal: new AbortController().signal,
      ...(agent === undefined ? {} : { agent }),
    })
  return { execute }
}

describe('主编排会话执行级护栏（E20）', () => {
  let env

  it('根 agent 调用被禁工具 → deny，isError 且理由可读', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute('read_semantic_paper', ROOT)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/主编排会话禁用重上下文工具 read_semantic_paper/)
    expect(JSON.stringify(result.content)).toMatch(/原则四/)
  })

  it('根 agent 调用未禁工具 → 正常执行', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute('search_papers', ROOT)
    expect(result.isError).toBe(false)
    expect(result.value).toBe('search_papers ran')
  })

  it('子代理调用被禁工具 → 正常执行（子代理归 toolFilter 管）', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute('read_semantic_paper', CHILD)
    expect(result.isError).toBe(false)
    expect(result.value).toBe('read_semantic_paper ran')
  })

  it('无 agent 的调用 → 护栏不生效（fail-open）', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute('read_semantic_paper', undefined)
    expect(result.isError).toBe(false)
  })

  it('自定义 deny 名单覆盖默认名单', async () => {
    env = await makeEnv({ denyForRoot: ['search_papers'] })
    const denied = await env.execute('search_papers', ROOT)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/search_papers/)
    // 默认名单里的 read_semantic_paper 不在自定义名单中 → 放行
    const allowed = await env.execute('read_semantic_paper', ROOT)
    expect(allowed.isError).toBe(false)
  })

  it('默认名单包含 5 个 read_* 与 5 个 download_*', async () => {
    const { ORCHESTRATOR_DENY_TOOLS } = await import('../lib/tools/names.js')
    const reads = ORCHESTRATOR_DENY_TOOLS.filter((n) => n.startsWith('read_'))
    const downloads = ORCHESTRATOR_DENY_TOOLS.filter((n) => n.startsWith('download_'))
    expect(reads).toHaveLength(5)
    expect(downloads).toHaveLength(5)
  })
})
