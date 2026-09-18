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

import { EXTRACTION_FIELDS } from '@cv-research/core'

import { KbService } from '../lib/kb/service.js'
import * as extractTool from '../lib/kb/extract-tool.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
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

/** 追加登记一篇**已解析**的论文（批量模式用）。 */
function seedParsed(service, id, title = `Paper ${id}`) {
  service.upsertPaper({
    paper_id: id,
    title,
    authors: [],
    source_channel: 'manual',
    pdf_status: 'downloaded',
    md_path: `data/papers/markdown/${id}/full.md`,
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
  })
}

/** 追加登记一篇**未解析**的论文（不该被批量模式选中）。 */
function seedUnparsed(service, id) {
  service.upsertPaper({
    paper_id: id,
    title: `Unparsed ${id}`,
    authors: [],
    source_channel: 'manual',
    pdf_status: 'pending',
    created_at: '2026-09-16T00:00:00Z',
    updated_at: '2026-09-16T00:00:00Z',
  })
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
  //
  // `options.replies` 用于**逐次**指定结果（第 N 次调用用第 N 项），批量模式测试用它
  // 造出"一篇成功、一篇失败"的部分成功场景；用完后回落到 structured。
  const structured = 'structured' in options ? options.structured : VALID_EXTRACTION
  const replies = options.replies ?? []
  let call = 0
  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
      const reply = replies[call]
      call += 1
      const chosen = reply ?? { structured, stopReason: options.stopReason ?? 'completed' }
      return {
        result: Promise.resolve({
          structured: chosen.structured,
          stopReason: chosen.stopReason ?? 'completed',
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
    // 输出是**逐篇结果**的统一形状（单篇与批量同形，见工具的 outputSchema）
    expect(result.value).toMatchObject({ total: 1, succeeded: 1, failed: 0, remaining: 0 })
    expect(result.value.results[0]).toMatchObject({
      paper_id: '10.1000/example',
      status: 'ok',
      extraction_quality: 'full_text',
    })

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

  // ── 单篇失败不再让整次调用 isError，而是落成该项的 status/error ──────────────
  // 理由：批量模式下"一篇失败"是正常结果（与 import_papers 的"部分成功"同一口径），
  // 若单篇与批量语义不同，调用方就得按模式分支判断——那是更差的契约。
  // 失败信号仍然明确：status='failed' + error 文本 + 未落库。
  it('子代理未按契约应答（无 structured）→ 该项 failed 且不落库', async () => {
    env = await makeEnv({ structured: undefined, stopReason: 'error' })
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.1000/example' })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ total: 1, succeeded: 0, failed: 1 })
    expect(result.value.results[0].status).toBe('failed')
    expect(result.value.results[0].error).toMatch(/未按契约应答/)
    expect(env.service.getExtraction('10.1000/example')).toBeUndefined()
  })

  it('结构形状非法（缺 method_summary）→ 该项 failed', async () => {
    env = await makeEnv({ structured: { problem_statement: '只有问题' } })
    const result = await env.execute('cvagent_kb_extract', { paper_id: '10.1000/example' })
    expect(result.isError).toBe(false)
    expect(result.value.results[0].status).toBe('failed')
    expect(result.value.results[0].error).toMatch(/形状非法/)
  })

  // ── P4-2 批量提取：库里积压"已解析未提取"时不必逐篇调用 ────────────────────
  it('批量模式：由库自己挑"已解析未提取"，跳过已提取与未解析的，逐篇处理', async () => {
    env = await makeEnv({})
    seedParsed(env.service, '10.1000/b')
    seedParsed(env.service, '10.1000/c')
    seedUnparsed(env.service, '10.1000/d') // 未解析：不该被选中
    env.service.saveExtraction({
      paper_id: '10.1000/example',
      problem_statement: '已有提取',
      method_summary: '不该被重复处理',
      innovations: [], future_work: [], limitations: [], benchmarks: [], metrics: [], baseline_methods: [],
      extraction_quality: 'full_text',
      extracted_at: '2026-09-16T00:00:00Z',
    })

    const result = await env.execute('cvagent_kb_extract', { limit: 5 })
    expect(result.isError).toBe(false)
    // 只剩 b、c 两篇待提取（example 已提取、d 未解析），按 paper_id 稳定排序
    expect(result.value).toMatchObject({ total: 2, succeeded: 2, failed: 0, remaining: 0 })
    expect(result.value.results.map((item) => item.paper_id)).toEqual(['10.1000/b', '10.1000/c'])
    expect(env.startCalls.map((call) => call.request.label)).toEqual(['reader:10.1000/b', 'reader:10.1000/c'])
    expect(env.service.getExtraction('10.1000/b')?.problem_statement).toBe('提升跨数据集泛化')
  })

  it('批量模式：limit 截断，且 remaining 告诉调用方还剩多少', async () => {
    env = await makeEnv({})
    seedParsed(env.service, '10.1000/b')
    seedParsed(env.service, '10.1000/c')
    seedParsed(env.service, '10.1000/e')

    const first = await env.execute('cvagent_kb_extract', { limit: 2 })
    expect(first.value).toMatchObject({ total: 2, succeeded: 2, remaining: 2 })
    const second = await env.execute('cvagent_kb_extract', { limit: 2 })
    // 第二次不会挑到刚做过的那两篇
    expect(second.value).toMatchObject({ total: 2, succeeded: 2, remaining: 0 })
    expect(env.service.unextractedCount()).toBe(0)
  })

  it('批量模式：一篇失败不影响其余（部分成功是正常结果）', async () => {
    env = await makeEnv({
      replies: [
        { structured: VALID_EXTRACTION, stopReason: 'completed' },
        { structured: undefined, stopReason: 'error' }, // 第二篇失败
      ],
    })
    seedParsed(env.service, '10.1000/b')

    const result = await env.execute('cvagent_kb_extract', { limit: 2 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ total: 2, succeeded: 1, failed: 1, remaining: 1 })
    // 选取顺序按 paper_id：'10.1000/b' < '10.1000/example'，所以 b 先被处理
    expect(result.value.results[0]).toMatchObject({ paper_id: '10.1000/b', status: 'ok' })
    expect(result.value.results[1]).toMatchObject({ paper_id: '10.1000/example', status: 'failed' })
    // 失败那篇没有落库，于是仍算"待提取"
    expect(env.service.getExtraction('10.1000/example')).toBeUndefined()
    expect(env.service.unextractedCount()).toBe(1)
  })

  it('批量模式：没有待提取的论文 → 明确 isError（并指路摘要工具）', async () => {
    env = await makeEnv({})
    env.service.saveExtraction({
      paper_id: '10.1000/example',
      problem_statement: '已有',
      method_summary: '已有',
      innovations: [], future_work: [], limitations: [], benchmarks: [], metrics: [], baseline_methods: [],
      extraction_quality: 'full_text',
      extracted_at: '2026-09-16T00:00:00Z',
    })
    const result = await env.execute('cvagent_kb_extract', { limit: 3 })
    expect(result.isError).toBe(true)
    // 文案里带引号，而这里是匹配 JSON 序列化后的文本（引号被转义）——只匹配不带引号的部分
    expect(JSON.stringify(result.content)).toMatch(/没有.*已解析但未提取.*的论文/)
    expect(JSON.stringify(result.content)).toMatch(/cvagent_kb_summary/)
    expect(env.startCalls).toHaveLength(0)
  })

  it('limit 被夹在 1–10（防一次调用拖太久）', async () => {
    env = await makeEnv({})
    seedParsed(env.service, '10.1000/b')
    seedParsed(env.service, '10.1000/c')
    const result = await env.execute('cvagent_kb_extract', { limit: 999 })
    // 夹到 10，但库里只有 3 篇待提取（example/b/c）
    expect(result.value.total).toBe(3)
    expect(env.startCalls).toHaveLength(3)
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
    // 断言与**契约常量同源**（`EXTRACTION_FIELDS`），不写死字段清单——
    // 写死的话每加一个字段（如 method_modules）测试就红，而红的原因不是产品坏了，
    // 是测试自己不会跟随（本项目已反复踩过：E33 的 toBe(0)、迁移版本号的 [1,2,3,4,5]）。
    expect(schema.required).toEqual([...EXTRACTION_FIELDS])
    expect(schema.properties.extraction_quality.enum).toEqual(['full_text', 'abstract_only'])
    // 每个契约字段都要在 schema 里有定义（否则 additionalProperties:false 会把它拒掉）
    for (const field of EXTRACTION_FIELDS) {
      expect(schema.properties[field], `契约字段 ${field} 在 outputSchema 里没有定义`).toBeDefined()
    }
  })
})
