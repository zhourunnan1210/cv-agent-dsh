/**
 * 主编排会话执行级护栏的集成测试（E20 落地）。
 *
 * 用真实 ToolRuntime 的执行管线验证：
 * - 根 agent（主会话）调用被禁工具 → deny，结果 isError 且理由可读；
 * - 根 agent 调用未禁工具 → 正常执行；
 * - 子代理（不在 roots 里）调用被禁工具 → 正常执行（子代理归 toolFilter 管）；
 * - 无 agent 的调用（agentless）→ 护栏不生效（fail-open）；
 * - 自定义 deny 名单覆盖默认名单。
 *
 * 2026-09-16：默认名单随检索后端换成 Asta 而重写。旧名单是 dsh-ai4scholar 的
 * 5 个 `read_*` + 5 个 `download_*`，而 Asta 里这两个前缀**一个都不存在**；
 * 现在唯一被禁的是全族最重的 `snippet_search`。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { ASTA_TOOL_NAMES, ORCHESTRATOR_DENY_TOOLS } from '../lib/tools/names.js'
import * as guard from '../lib/state/orchestrator-guard.js'

/** 默认被禁的工具（根 agent 不得调用）。 */
const DENIED = ASTA_TOOL_NAMES.snippetSearch
/** 默认放行的工具（护栏不应误伤）。 */
const ALLOWED = ASTA_TOOL_NAMES.searchByRelevance

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
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
  runtime.register(makeTool(DENIED))
  runtime.register(makeTool(ALLOWED))
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
    const result = await env.execute(DENIED, ROOT)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(`主编排会话禁用重上下文工具 ${DENIED}`)
    expect(JSON.stringify(result.content)).toMatch(/原则四/)
  })

  it('根 agent 调用未禁工具 → 正常执行', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute(ALLOWED, ROOT)
    expect(result.isError).toBe(false)
    expect(result.value).toBe(`${ALLOWED} ran`)
  })

  it('子代理调用被禁工具 → 正常执行（子代理归 toolFilter 管）', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute(DENIED, CHILD)
    expect(result.isError).toBe(false)
    expect(result.value).toBe(`${DENIED} ran`)
  })

  it('无 agent 的调用 → 护栏不生效（fail-open）', async () => {
    env = await makeEnv(undefined)
    const result = await env.execute(DENIED, undefined)
    expect(result.isError).toBe(false)
  })

  it('自定义 deny 名单覆盖默认名单', async () => {
    env = await makeEnv({ denyForRoot: [ALLOWED] })
    const denied = await env.execute(ALLOWED, ROOT)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain(ALLOWED)
    // 默认名单里的 snippet_search 不在自定义名单中 → 放行
    const allowed = await env.execute(DENIED, ROOT)
    expect(allowed.isError).toBe(false)
  })

  it('默认名单只含 Asta 契约里的重量级工具', () => {
    expect([...ORCHESTRATOR_DENY_TOOLS]).toEqual([ASTA_TOOL_NAMES.snippetSearch])
    // 名单必须是契约子集：拼错或引用已下线的名字会让护栏静默失效，
    // 而"静默失效"正是本项目最不能接受的一类缺陷。
    const contract = new Set(Object.values(ASTA_TOOL_NAMES))
    for (const name of ORCHESTRATOR_DENY_TOOLS) {
      expect(contract.has(name)).toBe(true)
    }
  })
})
