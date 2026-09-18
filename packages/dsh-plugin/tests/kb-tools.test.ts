/**
 * cvagent_kb_import_paper 工具的真实管线测试。
 *
 * 组装与 state-tools.test.ts 同款：真实 ToolRuntime + 真实 KbService（临时
 * metadata.db）+ 工具行直接 apply（注入机制由 preset mount-validate 覆盖）。
 * 验证：参数校验、插入、paper_id 合并、外部 ID 合并、标题命中 needs_review、
 * source_channel 落库与归一化。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as kbTools from '../lib/kb/tools.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

async function makeEnv(dbPath) {
  const app = new cordis.Context()
  let runtime
  let service
  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      service = new KbService(coreCtx, { dbPath })
    },
  })
  // 工具行直接 apply：真实 runtime + 真实 service（注入机制由 preset 验证覆盖）
  kbTools.apply({ tools: runtime, kb: service })

  let seq = 0
  const execute = (name, args) =>
    runtime.execute({
      callId: `call-${++seq}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
  return { execute, service }
}

const BASE = {
  paper_id: '10.1000/example',
  title: 'Example Deepfake Detection Paper',
  authors: ['Alice'],
  source_channel: 'asta',
}

describe('cvagent_kb_import_paper（真实管线）', () => {
  let dir
  let env

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-kb-tools-'))
    env = await makeEnv(join(dir, 'metadata.db'))
  })

  afterEach(async () => {
    // 先关 SQLite 连接再删目录，否则 Windows 下 EBUSY
    env.service.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('缺必填参数 → 参数校验 isError', async () => {
    const result = await env.execute('cvagent_kb_import_paper', { title: 'x' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/paper_id/)
  })

  it('正常入库 → inserted，service 可见，channel 计数正确', async () => {
    const result = await env.execute('cvagent_kb_import_paper', BASE)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ inserted: true, merged: false, matched_kind: 'none', needs_review: false })
    expect(env.service.count()).toBe(1)
    expect(env.service.countByChannel()).toEqual({ asta: 1 })
  })

  it('同 DOI（不同写法）再次入库 → paper_id 合并', async () => {
    await env.execute('cvagent_kb_import_paper', BASE)
    const result = await env.execute('cvagent_kb_import_paper', {
      ...BASE,
      paper_id: 'https://doi.org/10.1000/EXAMPLE',
      authors: ['Alice', 'Bob'],
      citation_count: 7,
    })
    expect(result.value).toMatchObject({ inserted: false, merged: true, matched_kind: 'paper_id' })
    const merged = env.service.getPaper('10.1000/example')
    expect(merged?.authors).toEqual(['Alice', 'Bob'])
    expect(merged?.citation_count).toBe(7)
  })

  it('外部 ID（doi）合并且 PK 不漂移', async () => {
    await env.execute('cvagent_kb_import_paper', { ...BASE, paper_id: 'local:abc', doi: '10.1000/example' })
    const result = await env.execute('cvagent_kb_import_paper', { ...BASE, doi: '10.1000/example' })
    expect(result.value).toMatchObject({ merged: true, matched_kind: 'external_id', merged_into: 'local:abc' })
    expect(env.service.getPaper('local:abc')).toBeDefined()
  })

  it('标题命中 → needs_review，不写库', async () => {
    await env.execute('cvagent_kb_import_paper', { ...BASE, paper_id: 'local:abc' })
    const result = await env.execute('cvagent_kb_import_paper', {
      ...BASE,
      paper_id: '10.1000/other',
      title: 'Example  Deepfake-Detection Paper',
    })
    expect(result.value).toMatchObject({ needs_review: true, matched_kind: 'title', inserted: false })
    expect(env.service.count()).toBe(1)
  })

  it('source_channel 与 pdf_status 落库', async () => {
    await env.execute('cvagent_kb_import_paper', { ...BASE, source_channel: 'manual', pdf_status: 'downloaded' })
    const record = env.service.getPaper('10.1000/example')
    expect(record?.source_channel).toBe('manual')
    expect(record?.pdf_status).toBe('downloaded')
  })
})
