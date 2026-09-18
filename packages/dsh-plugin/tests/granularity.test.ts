/**
 * 粒度契约与两端同构（整合设计 v1.0 §4.2 / §3.2）的测试。
 *
 * 这一层要修的是**粒度不对齐**——而它不是理论风险，是实测过的：
 * `lexicalSimilarity` 按并集归一化，idea 写到 651 字时，即使把论文条目原文
 * **一字不差**抄进去，相似度也只有 0.1785 → `novelty` 给 82 分。
 * 而生成端的 prompt/schema 此前**对长度与实质一个字都没提**，模型天然产短句。
 *
 * 所以测试钉三件事：
 * 1. 契约只有一个源（两端渲染同一份），且边界行为明确（空文本、纯空白、超长）；
 * 2. `method_modules` 能完整往返（存进去什么，读出来什么）；
 * 3. **"没给模块"与"给了空模块"要能区分**——前者回落到 innovations 派生，
 *    后者说明 Reader 按要求返回了空。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import {
  GRANULARITY,
  checkGranularity,
  checkGranularityBatch,
  countChars,
  describeViolation,
  renderGranularityPrompt,
  type GranularityField,
} from '@cv-research/core'

import { KbService } from '../lib/kb/service.js'
import * as extractTool from '../lib/kb/extract-tool.js'

const { resolveDshModules } = await import(new URL('../../../scripts/lib/dsh-root.mjs', import.meta.url).href)
const DSH = resolveDshModules()
const require = createRequire(DSH + '@deepseek-ai/dsh-system-prompt/package.json')
const systemPromptModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(
  pathToFileURL(createRequire(DSH + '@deepseek-ai/cordis/package.json').resolve('@deepseek-ai/cordis')).href
)

const NOW = '2026-09-17T00:00:00Z'
const fill = (n: number) => '字'.repeat(n)

describe('粒度契约（一处定义，两端引用）', () => {
  it('计长忽略空白：靠换行与空格撑长度骗不过判据', () => {
    expect(countChars('跨 数据 集\n泛化')).toBe(6)
  })

  it('过短 / 合规 / 过长三种边界', () => {
    const spec = GRANULARITY.problem
    expect(checkGranularity('problem', fill(spec.min - 1))[0]).toMatchObject({ kind: 'too_short' })
    expect(checkGranularity('problem', fill(spec.min))).toEqual([])
    expect(checkGranularity('problem', fill(spec.max))).toEqual([])
    expect(checkGranularity('problem', fill(spec.max + 1))[0]).toMatchObject({ kind: 'too_long' })
  })

  it('空文本算过短（不是"跳过检查"）', () => {
    expect(checkGranularity('method', '   ')[0]).toMatchObject({ kind: 'too_short', chars: 0 })
  })

  it('批量检查一次报清全部偏差，并带得体的名字', () => {
    const violations = checkGranularityBatch([
      { field: 'problem', text: fill(10), label: 'problem_statement' },
      { field: 'module_description', text: fill(5), label: '模块 M2「频域约束」的描述' },
      { field: 'method', text: fill(600) },
    ])
    expect(violations).toHaveLength(2)
    const text = violations.map(describeViolation).join('\n')
    expect(text).toContain('problem_statement：10 字')
    expect(text).toContain('模块 M2「频域约束」的描述：5 字')
    expect(text).toContain('过短')
  })

  it('prompt 渲染与契约同源（改了契约，两端 prompt 自动跟随）', () => {
    const rendered = renderGranularityPrompt(['problem', 'method'])
    expect(rendered).toContain(`${GRANULARITY.problem.min}–${GRANULARITY.problem.max} 字`)
    expect(rendered).toContain(GRANULARITY.problem.requirement)
    expect(rendered.split('\n')).toHaveLength(2)
    // 全量渲染覆盖契约的所有键
    const all = renderGranularityPrompt()
    for (const key of Object.keys(GRANULARITY) as GranularityField[]) {
      expect(all, `契约字段 ${key} 没有出现在渲染结果里`).toContain(key)
    }
  })
})

describe('两端同构：提取侧 method_modules', () => {
  let dir
  let kb

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-granularity-'))
    const app = new cordis.Context()
    await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
    await app.plugin({
      name: 'kb',
      inject: ['systemPrompt'],
      apply(ctx) { kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') }) },
    })
    kb.upsertPaper({
      paper_id: '10.1/a', title: 'Paper A', authors: [], source_channel: 'asta',
      pdf_status: 'downloaded', md_path: 'markdown/10.1/a/full.md', parse_channel: 'mineru',
      created_at: NOW, updated_at: NOW,
    })
  })

  afterEach(async () => {
    kb?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('method_modules 完整往返（存进去什么，读出来什么）', () => {
    kb.saveExtraction({
      paper_id: '10.1/a',
      problem_statement: '跨数据集泛化不足',
      method_summary: '整体方法叙述',
      method_modules: [
        { name: '频域一致性约束', role: '抑制遗忘', description: '对频谱响应做一致性约束', kind: 'loss' },
        { name: 'CLIP 主干', role: '特征提取', description: '冻结的视觉主干', kind: 'backbone' },
      ],
      innovations: ['频域一致性损失'],
      future_work: [],
      limitations: [],
      benchmarks: [],
      metrics: [],
      baseline_methods: [],
      extraction_quality: 'full_text',
      extracted_at: NOW,
    })

    const read = kb.getExtraction('10.1/a')
    expect(read.method_modules).toHaveLength(2)
    expect(read.method_modules[0]).toMatchObject({ name: '频域一致性约束', kind: 'loss' })
    expect(read.method_modules[1].kind).toBe('backbone')
  })

  it('没有 method_modules 的提取（早期数据）读回来是 undefined，而不是空数组', () => {
    kb.saveExtraction({
      paper_id: '10.1/a',
      problem_statement: 'x', method_summary: 'y',
      innovations: [], future_work: [], limitations: [], benchmarks: [], metrics: [], baseline_methods: [],
      extraction_quality: 'full_text', extracted_at: NOW,
    })
    const read = kb.getExtraction('10.1/a')
    expect(read.method_modules, '"这份提取早于该字段"必须与"提取了但没有模块"区分开').toBeUndefined()
  })

  it('Reader 的输出契约把粒度要求写进了字段描述（不再是一句"方法概述"）', () => {
    const schema = extractTool.extractionOutputSchema()
    expect(schema.properties.method_summary.description).toContain(`${GRANULARITY.method.min}–${GRANULARITY.method.max} 字`)
    expect(schema.properties.problem_statement.description).toContain(GRANULARITY.problem.requirement)
    const moduleSchema = schema.properties.method_modules.items
    expect(moduleSchema.required).toEqual(['name', 'role', 'description', 'kind'])
    expect(moduleSchema.properties.kind.enum).toContain('backbone')
  })

  it('Reader persona 明确要求"方法组成拆解"且标准件也算模块', () => {
    const persona = extractTool.READER_PERSONA
    expect(persona).toContain('method_modules')
    expect(persona, '要说明它是组成而非创新点，否则模型只会写新东西').toContain('标准件')
  })
})
