/**
 * 研究流程工具测试（P3-4）：真实 ToolRuntime + 假 subagents 提供者。
 *
 * 覆盖：
 * - `cvagent_kb_scout`：委派契约（只给 Asta 检索工具、不含 snippet_search）、
 *   候选形状校验、**没有外部标识的候选不入可入库清单**、缺范围时明确报错；
 * - `cvagent_kb_import_papers`：批量入库逐条回传（部分成功是正常结果）、坏条目只影响自己；
 * - `cvagent_kb_analyze`：确定性去重上下文（既有条目进 prompt）、Analyst 只拿只读工具、
 *   提案形状校验（缺 source_papers 的丢弃）、`dry_run` 不写库、真实写入的 created/merged 计数。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import * as researchTools from '../lib/kb/research-tools.js'
import { KB_TOOLS } from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

const ROOT_AGENT = { id: 'session-root' }
const NOW = '2026-09-17T00:00:00Z'

async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cvagent-research-'))
  const app = new cordis.Context()
  let runtime
  let kb
  const startCalls = []
  let call = 0

  await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
  await app.plugin({
    name: 'core',
    inject: ['systemPrompt'],
    apply(coreCtx) {
      runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
      kb = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
    },
  })

  const fakeSubagents = {
    start(name, request) {
      startCalls.push({ name, request })
      const reply = (options.replies ?? [])[call]
      call += 1
      return {
        result: Promise.resolve(reply ?? { structured: { papers: [] }, stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }

  researchTools.apply({
    tools: runtime,
    kb,
    get: (name) => (name === 'subagents' ? fakeSubagents : undefined),
  })

  let seq = 0
  const execute = (name, args) => runtime.execute({
    callId: `call-${++seq}`,
    name,
    arguments: args,
    agent: ROOT_AGENT,
    signal: new AbortController().signal,
  })

  return {
    execute,
    kb,
    startCalls,
    dir,
    schemas: () => runtime.schemas().map((schema) => schema.name),
    async cleanup() {
      kb.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const SCOUT_REPLY = {
  structured: {
    papers: [
      { title: 'Does Audio Deepfake Detection Generalize?', arxiv_id: '2203.16263', year: 2022, venue: 'Interspeech', relevance: '直接同题' },
      { title: 'No external id paper' }, // 无 DOI/arXiv → 不入可入库清单
      { title: 'AASIST: Audio Anti-Spoofing Using Integrated Spectro-Temporal Graph Attention Networks', doi: '10.1109/ICASSP48485.2024.00000', year: 2024 },
    ],
  },
  stopReason: 'completed',
}

describe('cvagent_kb_scout / import_papers / analyze（真实 ToolRuntime + 假 subagents）', () => {
  let env

  afterEach(async () => {
    if (env !== undefined) {
      await env.cleanup()
      env = undefined
    }
  })

  it('三个工具名注册进目录（与 names.ts 契约一致）', async () => {
    env = await makeEnv({})
    const names = env.schemas()
    for (const expected of [KB_TOOLS.scout, KB_TOOLS.importPapers, KB_TOOLS.analyze]) {
      expect(names).toContain(expected)
    }
    expect(names).toHaveLength(3)
  })

  it('scout：委派契约正确；无外部标识的候选不进 import 清单', async () => {
    env = await makeEnv({ replies: [SCOUT_REPLY] })
    const result = await env.execute(KB_TOOLS.scout, {
      sub_domain: '音频深伪检测',
      keywords: ['audio deepfake', 'ASVspoof'],
      max_results: 20,
    })
    expect(result.isError).toBe(false)
    expect(result.value.count).toBe(3)
    expect(result.value.with_external_id).toBe(2)

    const [call] = env.startCalls
    expect(call.name).toBe('spawn')
    expect(call.request.parent).toBe(ROOT_AGENT)
    expect(call.request.maxDepth).toBe(0)
    expect(call.request.persona).toContain('Scout')
    expect(call.request.outputSchema.properties.papers.type).toBe('array')
    // 隔离红线：Scout 不含 snippet_search（正文留给后续取证）
    const allow = call.request.toolFilter.allow
    expect(allow).not.toContain('mcp__asta__snippet_search')
    expect(allow).toContain('mcp__asta__get_paper_batch')
    // prompt 里带上范围与检索提示
    const prompt = String(call.request.prompt[0].text)
    expect(prompt).toContain('音频深伪检测')
    expect(prompt).toContain('ASVspoof')
    expect(prompt).toContain('limit 不生效') // 提醒别用 relevance 检索做批量

    // import_json 只含可入库的两条
    const importable = JSON.parse(result.value.import_json)
    expect(importable).toHaveLength(2)
    expect(importable[0]).toMatchObject({ paper_id: '2203.16263', arxiv_id: '2203.16263' })
    expect(importable[1].paper_id).toBe('10.1109/ICASSP48485.2024.00000')
  })

  it('scout：缺检索范围 → 明确 isError（不让子代理瞎猜）', async () => {
    env = await makeEnv({})
    const result = await env.execute(KB_TOOLS.scout, {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/缺少检索范围/)
  })

  it('scout：子代理未按契约应答 → isError', async () => {
    env = await makeEnv({ replies: [{ structured: undefined, stopReason: 'error' }] })
    const result = await env.execute(KB_TOOLS.scout, { sub_domain: 'x' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/未按契约应答/)
  })

  it('import_papers：逐条回传结果，坏条目只影响自己（部分成功是正常结果）', async () => {
    env = await makeEnv({})
    const first = await env.execute(KB_TOOLS.importPapers, {
      papers_json: JSON.stringify([
        { paper_id: '2203.16263', title: 'Does Audio Deepfake Detection Generalize?', arxiv_id: '2203.16263', year: 2022 },
        { paper_id: '10.1/x', title: 'Second paper' },
        { paper_id: '', title: '缺 id 的坏条目' },
      ]),
    })
    expect(first.isError).toBe(false)
    expect(first.value).toMatchObject({ total: 3, inserted: 2, merged: 0, needs_review: 0, failed: 1 })
    expect(first.value.details.map((item) => item.outcome)).toEqual(['inserted', 'inserted', 'error'])
    expect(env.kb.count()).toBe(2)

    // 再导一次同一批：命中去重 → merged，不重复入库
    const second = await env.execute(KB_TOOLS.importPapers, {
      papers_json: JSON.stringify([{ paper_id: '2203.16263', title: 'Does Audio Deepfake Detection Generalize?', arxiv_id: '2203.16263' }]),
    })
    expect(second.value).toMatchObject({ inserted: 0, merged: 1 })
    expect(env.kb.count()).toBe(2)

    // 非法 JSON → 明确 isError
    const bad = await env.execute(KB_TOOLS.importPapers, { papers_json: '{不是数组' })
    expect(bad.isError).toBe(true)
  })

  it('analyze：确定性去重上下文进 prompt；只给只读检索工具；写入计数正确', async () => {
    env = await makeEnv({
      replies: [{
        structured: {
          entries: [
            { store: 'problems', statement: '音频深伪检测的跨数据集泛化不足', source_papers: ['2203.16263'], ext_json: '{"deepfake-detection":{"modality":"audio"}}' },
            { store: 'innovations', statement: 'Gaussian 目标的自监督同步预训练', source_papers: ['2203.16263'] },
            { store: 'problems', statement: '缺来源的坏提案', source_papers: [] }, // 形状不合规 → 丢弃
            { store: 'bogus', statement: '库名非法', source_papers: ['2203.16263'] }, // 库名非法 → 丢弃
          ],
        },
        stopReason: 'completed',
      }],
    })
    // 预置一篇提取 + 一条既有条目（应出现在 Analyst 的"已有条目"上下文里）
    env.kb.upsertEntry('problems', '音频深伪的泛化问题：未见生成方法下性能下降', ['10.1/seed'], {})
    env.kb.saveExtraction({
      paper_id: '2203.16263',
      problem_statement: '音频深伪检测在未见攻击与数据集上泛化差',
      method_summary: '自监督同步预训练 + 下游分类',
      innovations: ['Gaussian 目标损失'],
      future_work: [],
      limitations: ['在噪声环境下退化'],
      benchmarks: ['ASVspoof'],
      metrics: ['EER'],
      baseline_methods: ['AASIST'],
      extraction_quality: 'full_text',
      extracted_at: NOW,
    })

    const result = await env.execute(KB_TOOLS.analyze, { paper_ids: ['2203.16263'] })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ analyzed_papers: 1, proposed: 2, created: 2, merged: 0, skipped: 2, dry_run: false })

    const [call] = env.startCalls
    expect(call.name).toBe('spawn')
    expect(call.request.toolFilter).toEqual({ allow: [KB_TOOLS.search, KB_TOOLS.summary] })
    expect(call.request.persona).toContain('Analyst')
    const prompt = String(call.request.prompt[0].text)
    expect(prompt).toContain('2203.16263')
    expect(prompt).toContain('音频深伪检测在未见攻击与数据集上泛化差')
    expect(prompt).toContain('[problems] 音频深伪的泛化问题') // 既有条目进上下文，避免重复建档

    // 真实落库 + 计数
    expect(env.kb.entrySummary().counts).toMatchObject({ problems: 2, innovations: 1 })
    expect(result.value.outcomes[0]).toMatchObject({ store: 'problems', merged: false })
  })

  it('analyze：dry_run 只回提案不写库', async () => {
    env = await makeEnv({
      replies: [{
        structured: { entries: [{ store: 'methods', statement: '自监督同步预训练', source_papers: ['10.1/a'] }] },
        stopReason: 'completed',
      }],
    })
    env.kb.saveExtraction({
      paper_id: '10.1/a',
      problem_statement: 'p', method_summary: 'm', innovations: [], future_work: [], limitations: [],
      benchmarks: [], metrics: [], baseline_methods: [], extraction_quality: 'full_text', extracted_at: NOW,
    })
    const before = env.kb.entrySummary().total
    const result = await env.execute(KB_TOOLS.analyze, { paper_ids: ['10.1/a'], dry_run: true })
    expect(result.value).toMatchObject({ dry_run: true, proposed: 1, created: 0, merged: 0 })
    expect(result.value.outcomes[0].entry_id).toBe('DRY-1')
    expect(env.kb.entrySummary().total).toBe(before)
  })

  it('analyze：没有可归纳的提取 → 明确 isError', async () => {
    env = await makeEnv({})
    const result = await env.execute(KB_TOOLS.analyze, { paper_ids: ['10.1/无提取'] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/没有可归纳的提取结果/)
  })
})
