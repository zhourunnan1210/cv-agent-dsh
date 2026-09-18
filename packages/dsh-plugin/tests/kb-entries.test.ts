/**
 * 三库读写工具测试（P3-1）：`cvagent_kb_upsert_entry` / `cvagent_kb_search` / `cvagent_kb_summary`。
 *
 * 走**真实 ToolRuntime 管线**（与 kb-extract 测试同款）：注册 → execute → 断言
 * 真实返回值与落库效果。`kb` 服务用临时库，互不干扰。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as entryTools from '../lib/kb/entry-tools.js'
import { KB_TOOLS } from '../lib/tools/names.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

/** 组装：systemPrompt → ToolRuntime → kb 服务（临时库）→ 三库工具行。 */
async function makeEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-entries-'))
  const app = new cordis.Context()
  let runtime
  let service
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

  entryTools.apply({ tools: runtime, kb: service })

  let seq = 0
  const execute = (name, args) => runtime.execute({
    callId: `call-${++seq}`,
    name,
    arguments: args,
    agent: { id: 'session-root' },
    signal: new AbortController().signal,
  })
  return {
    execute,
    service,
    schemas: () => runtime.schemas().map((schema) => schema.name),
    async cleanup() {
      for (const item of services) item.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const validEntry = {
  store: 'innovations',
  statement: '动态轮廓卷积（DCConv）：可学习偏移与自适应坐标轴',
  source_papers: ['10.1000/example'],
  ext_json: '{"deepfake-detection":{"innovation_type":"new_method"}}',
}

describe('三库读写工具（真实 ToolRuntime）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) {
      await env.cleanup()
      env = undefined
    }
  })

  it('三个工具名注册进目录（与 names.ts 契约一致）', async () => {
    env = await makeEnv()
    const names = env.schemas()
    expect(names).toContain(KB_TOOLS.upsertEntry)
    expect(names).toContain(KB_TOOLS.search)
    expect(names).toContain(KB_TOOLS.summary)
    expect(names).toHaveLength(3)
  })

  it('upsert_entry 新建 → 可用 search 检索到 → summary 计数同步', async () => {
    env = await makeEnv()
    const created = await env.execute(KB_TOOLS.upsertEntry, validEntry)
    expect(created.isError).toBe(false)
    expect(created.value).toMatchObject({ entry_id: 'I001', store: 'innovations', merged: false, merged_into: '' })

    const found = await env.execute(KB_TOOLS.search, { query: 'DCConv' })
    expect(found.isError).toBe(false)
    expect(found.value.count).toBe(1)
    expect(found.value.entries[0]).toMatchObject({ entry_id: 'I001', store: 'innovations' })
    expect(JSON.parse(found.value.entries[0].ext_json)).toEqual({ 'deepfake-detection': { innovation_type: 'new_method' } })

    const summary = await env.execute(KB_TOOLS.summary, {})
    expect(summary.value).toMatchObject({ entries_innovations: 1, entries_total: 1, papers: 0, extractions: 0 })
    expect(summary.value.latest_entry_update).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('upsert_entry 命中既有条目 → merged=true、来源并集、ext 合并', async () => {
    env = await makeEnv()
    await env.execute(KB_TOOLS.upsertEntry, validEntry)
    const merged = await env.execute(KB_TOOLS.upsertEntry, {
      store: 'innovations',
      statement: '动态轮廓卷积 DCConv 可学习偏移与自适应坐标轴', // 归一化后与上一条相等
      source_papers: ['10.1000/other'],
      ext_json: '{"deepfake-detection":{"paradigm":"spatial"}}',
    })
    expect(merged.value).toMatchObject({ entry_id: 'I001', merged: true, merged_into: 'I001' })
    const entry = env.service.getEntry('innovations', 'I001')
    expect(entry?.source_papers).toEqual(['10.1000/example', '10.1000/other'])
    expect(entry?.ext).toEqual({ 'deepfake-detection': { innovation_type: 'new_method', paradigm: 'spatial' } })
  })

  it('upsert_entry 参数校验：空 statement / 空来源 / 坏 ext_json 都是明确 isError', async () => {
    env = await makeEnv()
    const emptyStatement = await env.execute(KB_TOOLS.upsertEntry, { ...validEntry, statement: '   ' })
    expect(emptyStatement.isError).toBe(true)
    expect(JSON.stringify(emptyStatement.content)).toMatch(/statement 不可为空/)

    const noSource = await env.execute(KB_TOOLS.upsertEntry, { ...validEntry, source_papers: [] })
    expect(noSource.isError).toBe(true)
    expect(JSON.stringify(noSource.content)).toMatch(/source_papers 至少一条/)

    const badExt = await env.execute(KB_TOOLS.upsertEntry, { ...validEntry, ext_json: '{不是 JSON' })
    expect(badExt.isError).toBe(true)
    expect(JSON.stringify(badExt.content)).toMatch(/ext_json 不是合法 JSON/)

    const arrayExt = await env.execute(KB_TOOLS.upsertEntry, { ...validEntry, ext_json: '[1,2]' })
    expect(arrayExt.isError).toBe(true)
    expect(JSON.stringify(arrayExt.content)).toMatch(/必须是一个 JSON 对象/)
  })

  it('search 支持 store / source_paper / limit 过滤，跨库按 problems→methods→innovations 分组', async () => {
    env = await makeEnv()
    await env.execute(KB_TOOLS.upsertEntry, { store: 'problems', statement: '跨数据集泛化不足', source_papers: ['10.1/a'], ext_json: '{}' })
    await env.execute(KB_TOOLS.upsertEntry, { store: 'methods', statement: 'WMamba 小波 + Mamba 主干', source_papers: ['10.1/a'], ext_json: '{}' })
    await env.execute(KB_TOOLS.upsertEntry, { store: 'innovations', statement: 'DCConv 动态轮廓卷积', source_papers: ['10.1/b'], ext_json: '{}' })

    const all = await env.execute(KB_TOOLS.search, {})
    expect(all.value.entries.map((entry) => entry.store)).toEqual(['problems', 'methods', 'innovations'])

    const onlyMethods = await env.execute(KB_TOOLS.search, { store: 'methods' })
    expect(onlyMethods.value.entries.map((entry) => entry.entry_id)).toEqual(['M001'])

    const bySource = await env.execute(KB_TOOLS.search, { source_paper: '10.1/a' })
    expect(bySource.value.entries.map((entry) => entry.entry_id).sort()).toEqual(['M001', 'P001'])

    const limited = await env.execute(KB_TOOLS.search, { store: 'methods', limit: 1 })
    expect(limited.value.count).toBe(1)

    // 2 字中文（trigram 查不到）必须靠 LIKE 回退给出结果，而不是空
    const twoChar = await env.execute(KB_TOOLS.search, { query: '泛化' })
    expect(twoChar.value.entries.map((entry) => entry.entry_id)).toEqual(['P001'])
  })

  it('summary 反映论文库与提取面（论文 / 通道 / 提取数）', async () => {
    env = await makeEnv()
    const now = new Date().toISOString()
    env.service.upsertPaper({
      paper_id: '10.1000/example',
      title: 'Example',
      authors: [],
      source_channel: 'asta',
      pdf_status: 'pending',
      created_at: now,
      updated_at: now,
    })
    env.service.saveExtraction({
      paper_id: '10.1000/example',
      problem_statement: '问题',
      method_summary: '方法',
      innovations: [],
      future_work: [],
      limitations: [],
      benchmarks: [],
      metrics: [],
      baseline_methods: [],
      extraction_quality: 'full_text',
      extracted_at: now,
    })
    const summary = await env.execute(KB_TOOLS.summary, {})
    expect(summary.value.papers).toBe(1)
    expect(JSON.parse(summary.value.papers_by_channel)).toEqual({ asta: 1 })
    expect(summary.value.extractions).toBe(1)
    expect(summary.value.entries_total).toBe(0)
    expect(summary.value.latest_entry_update).toBe('')
  })
})
