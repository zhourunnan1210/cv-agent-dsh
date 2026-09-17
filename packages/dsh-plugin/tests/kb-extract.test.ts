/**
 * cvagent_kb_extract（Reader 子代理委派）测试。
 *
 * 用**假 subagents 提供者**验证委派契约（不跑真实 LLM）：
 * - 委派请求形状：provider 'spawn'、parent=调用 agent、toolFilter 只含 read、
 *   persona 为 Reader、outputSchema 为 PaperExtraction 编译、maxDepth 乐观可派；
 * - 结构化结果合规 → saveExtraction 落库；
 * - 缺 paper / 未解析 / 无 subagents / 无 agent / 结果不合规 → 明确 isError。
 *
 * 真实端到端（LLM 子代理）属 Phase 2 验收的人工步骤（P2-7）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as extractTool from '../lib/kb/extract-tool.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

const ROOT_AGENT = { id: 'session-root' }

const VALID_EXTRACTION = {
  problem_statement: '提升跨数据集泛化',
  method_summary: '多尺度融合网络',
  innovations: ['模块A'],
  future_work: [],
  limitations: ['算力高'],
  benchmarks: ['FF++'],
  metrics: ['AUC'],
  baseline_methods: ['Xception'],
  extraction_quality: 'full_text',
}

/** 组装：systemPrompt → ToolRuntime → kb（含一篇已解析论文）→ 假 subagents → 工具行。 */
async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-extract-'))
  const app = new cordis.Context()
  let runtime
  let service
  let startCalls = []
  const services = []

  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      service = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
      services.push(service)
    },
  })

  // 种子：一篇已解析的论文
  service.upsertPaper({
    paper_id: '10.1000/example',
    title: 'Example Deepfake Detection Paper',
    authors: ['Alice'],
    source_channel: 'manual',
    pdf_status: 'downloaded',
    md_path: 'data/papers/markdown/10.1000/example/full.md',
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
  })

  // 假 subagents：记录委派请求，返回预设结果。
  // 注意：显式传 structured: undefined 表示「子代理没给结构化结果」，
  // 必须原样返回 undefined——只有未传该键时才回落 VALID_EXTRACTION。
  const structured = 'structured' in options ? options.structured : VALID_EXTRACTION
  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
      return {
        result: Promise.resolve({
          structured,
          stopReason: options.stopReason ?? 'completed',
        }),
        dispose: async () => {},
      }
    },
  }

  extractTool.apply({
    tools: runtime,
    kb: service,
    get: (name) => (name === 'subagents' ? fakeSubagents : undefined),
  })

  let seq = 0
  const execute = (name, args, agent = ROOT_AGENT) =>
    runtime.execute({
      callId: `call-${++seq}`,
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    })
  return {
    execute,
    service,
    startCalls,
    dir,
    /** 追加登记一个本环境内的 kb 服务（如测试内新建的实例），cleanup 一并关闭。 */
    registerService(extra) {
      services.push(extra)
    },
    /** Windows 下 sqlite 连接未关时删目录会 EBUSY：先关全部连接再删。 */
    async cleanup() {
      for (const s of services) s.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('cvagent_kb_extract（Reader 子代理委派，假 subagents）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) {
      await env.cleanup()
      env = undefined
    }
  })

  it('委派契约正确 + 结构化结果落库', async () => {
    env = await makeEnv({})
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.1000/example' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ paper_id: '10.1000/example', extraction_quality: 'full_text' })

    const [call] = env.startCalls
    expect(call.name).toBe('spawn')
    expect(call.request.parent).toBe(ROOT_AGENT)
    expect(call.request.toolFilter).toEqual({ allow: ['read'] })
    expect(call.request.persona).toContain('Reader 子代理')
    // E33 回归：深度上限是「子代理的绝对层级上限」，必须 ≥ 1（写 0 会让任何委派都失败）。
    // 真正的判据由 tests/subagent-depth.test.ts 调真 SDK 的 resolveChildDepth 校验。
    expect(call.request.maxDepth).toBeGreaterThanOrEqual(1)
    expect(call.request.outputSchema.required).toContain('problem_statement')
    expect(call.request.label).toBe('reader:10.1000/example')

    const saved = env.service.getExtraction('10.1000/example')
    expect(saved?.problem_statement).toBe('提升跨数据集泛化')
  })

  it('论文不存在 → 明确 isError', async () => {
    env = await makeEnv({})
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.9999/nope' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/论文不存在/)
  })

  it('子代理未按契约应答（无 structured）→ isError 且不落库', async () => {
    env = await makeEnv({ structured: undefined, stopReason: 'error' })
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.1000/example' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/未按契约应答/)
    expect(env.service.getExtraction('10.1000/example')).toBeUndefined()
  })

  it('结构形状非法（缺 method_summary）→ isError', async () => {
    env = await makeEnv({ structured: { problem_statement: '只有问题' } })
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.1000/example' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/形状非法/)
  })

  it('无 subagents 服务 → 明确 isError', async () => {
    env = await makeEnv({})
    // 重建一个不带 subagents 的工具行实例（单独 app 太贵，直接改 env 的 startCalls 不可行；
    // 用无 get 的 ctx 直接 apply 到新 runtime）
    const app = new cordis.Context()
    let runtime2
    let service2
    await app.plugin({ name: 'outer2', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
    await app.plugin({
      name: 'core2',
      inject: ['systemPrompt'],
      apply(coreCtx) {
        runtime2 = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
        service2 = new KbService(coreCtx, { dbPath: join(env.dir, 'metadata.db') })
      },
    })
    env.registerService(service2)
    extractTool.apply({ tools: runtime2, kb: service2, get: () => undefined })
    const result = await runtime2.execute({
      callId: 'call-no-sub',
      name: 'cvagent_kb_extract',
      arguments: { paper_id: '10.1000/example' },
      agent: ROOT_AGENT,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/subagents 服务不可用/)
  })

  it('outputSchema 是 PaperExtraction 契约的编译', () => {
    const schema = extractTool.extractionOutputSchema()
    expect(schema.required).toEqual([
      'problem_statement', 'method_summary', 'innovations', 'future_work',
      'limitations', 'benchmarks', 'metrics', 'baseline_methods', 'extraction_quality',
    ])
    expect(schema.properties.extraction_quality.enum).toEqual(['full_text', 'abstract_only'])
  })
})
