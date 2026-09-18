/**
 * 撞车链路（整合设计 v1.0 §5）的测试。
 *
 * 这一层要替代的旧机制有三个致命问题（都有实测），所以测试围绕"新机制真的修好了它们"：
 * 1. 旧机制拿整段算字符重合度 → 本层**逐模块对齐**（能表达"3 个模块里 2 个已有"）；
 * 2. 旧机制把证据截断到 160 字（methods 平均 141、最长 205 → 专家看到半句话）
 *    → 本层**不截断**；
 * 3. 旧机制把 `sim=0.012` 这种无语义的数喂给裁判做锚定 → 本层的专家上下文里
 *    **一个相似度数字都不出现**。
 *
 * 还有一条纪律要钉住：**本层是确定性的**，不调 LLM、不给最终判定——
 * `new / partial / known` 由三位专家给（§11.3 的分工）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { lexicalSimilarity } from '@cv-research/core'

import { KbService } from '../lib/kb/service.js'
import { collide, renderCollisionContext } from '../lib/scoring/collide.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + '@deepseek-ai/dsh-system-prompt/package.json')
const systemPromptModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(
  pathToFileURL(createRequire(DSH + '@deepseek-ai/cordis/package.json').resolve('@deepseek-ai/cordis')).href
)

const NOW = '2026-09-17T00:00:00Z'

/** 造一篇"已提取 + 有条目 + 有模块"的论文。 */
function seedPaper(kb, id, options = {}) {
  kb.upsertPaper({
    paper_id: id, title: `Paper ${id}`, authors: [], source_channel: 'asta',
    pdf_status: 'downloaded', md_path: `markdown/${id}/full.md`, parse_channel: 'mineru',
    created_at: NOW, updated_at: NOW, year: 2025,
  })
  kb.saveExtraction({
    paper_id: id,
    problem_statement: options.problem ?? '跨数据集泛化不足：未见生成器上性能骤降',
    method_summary: options.method ?? '频域一致性约束 + 稀疏回放缓冲的持续学习方法',
    method_modules: options.modules ?? [
      { name: '频域一致性约束', role: '抑制遗忘', description: '约束新旧任务在频谱响应上的一致性', kind: 'loss' },
      { name: '稀疏回放缓冲', role: '保留旧任务', description: '按分布密度挑选稀疏回放特征', kind: 'training_strategy' },
    ],
    innovations: options.innovations ?? ['频域一致性损失'],
    future_work: [],
    limitations: options.limitations ?? ['仅在 FF++ 上验证，未覆盖跨生成器设定'],
    benchmarks: ['FaceForensics++ (FF++)'],
    metrics: ['AUC'],
    baseline_methods: ['Xception'],
    extraction_quality: 'full_text',
    extracted_at: NOW,
  })
}

const IDEA = {
  idea_id: 'idea-1',
  title: '面向未见生成器的持续深伪检测',
  statement: '用频域一致性约束做持续学习',
  problem: '跨数据集泛化不足：检测器在未见生成器上性能显著下降',
  method: '在预训练主干上做增量适配，用频域一致性约束抑制遗忘，并用稀疏回放保留旧任务',
  innovation: '跨任务频域一致性',
  baselines: [],
  method_modules: [
    { name: '频域一致性约束', role: '抑制遗忘', description: '约束新旧任务在频谱响应上的一致性', kind: 'loss', expected_advantage: '比参数隔离更省' },
    { name: '原型对齐模块', role: '保持类间结构', description: '维护每类原型并在增量阶段对齐', kind: 'module', expected_advantage: '无需回放样本' },
  ],
}

describe('撞车链路（三轴召回 + 证据卡 + 模块级对齐）', () => {
  let dir
  let kb

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-collide-'))
    const app = new cordis.Context()
    await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
    await app.plugin({
      name: 'kb',
      inject: ['systemPrompt'],
      apply(ctx) { kb = new KbService(ctx, { dbPath: join(dir, 'metadata.db') }) },
    })
  })

  afterEach(async () => {
    kb?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('三轴并发召回：问题簇 / 模块 / 做法都进候选，并记录各自排名', async () => {
    seedPaper(kb, '10.1/a')
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a'], {})
    kb.upsertEntry('methods', '频域一致性约束 + 稀疏回放缓冲', ['10.1/a'], {})
    // 模块清单（提取时本会自动汇入；这里显式建，便于断言轴的独立性）
    kb.upsertModule({ name: '频域一致性约束', statement: '约束频谱响应一致性', kinds: ['loss'], paper_id: '10.1/a' })
    kb.upsertModule({ name: '稀疏回放缓冲', statement: '稀疏回放特征', kinds: ['training_strategy'], paper_id: '10.1/a' })

    const report = await collide(IDEA, kb, lexicalSimilarity)
    expect(report.idea_id).toBe('idea-1')
    expect(report.axes.problem_clusters.length).toBeGreaterThan(0)
    expect(report.axes.module_hits.length, 'idea 的两个模块都应产生候选召回记录').toBeGreaterThanOrEqual(1)
    expect(report.candidates).toContain('10.1/a')

    const card = report.evidence_cards.find((item) => item.paper_id === '10.1/a')
    expect(card, '候选论文必须有证据卡').toBeDefined()
    // 三轴至少命中两轴（问题 + 模块/做法）
    expect(Object.keys(card.axis_ranks).length).toBeGreaterThanOrEqual(2)
  })

  it('证据卡**不截断**：方法段与局限都完整（旧实现截 160 字，专家只能看到半句话）', async () => {
    const longMethod = `方法整体叙述。${'细节。'.repeat(80)}结论在此。`   // 远超 160 字
    const longLimitation = `仅在 FF++ 上验证。${'补充说明。'.repeat(20)}未覆盖跨生成器设定。`
    seedPaper(kb, '10.1/a', { method: longMethod, limitations: [longLimitation] })
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a'], {})

    const report = await collide(IDEA, kb, lexicalSimilarity)
    const card = report.evidence_cards.find((item) => item.paper_id === '10.1/a')
    expect(card.extraction.method_summary).toBe(longMethod)
    expect(card.extraction.limitations[0]).toBe(longLimitation)
    expect(card.extraction.method_summary.endsWith('结论在此。'), '截断会丢掉结论').toBe(true)
  })

  it('模块轴：给出 idea 每个模块的候选，且**不替专家下判定**', async () => {
    seedPaper(kb, '10.1/a')
    kb.upsertModule({ name: '频域一致性约束', statement: '约束频谱响应一致性', kinds: ['loss'], paper_id: '10.1/a' })

    const report = await collide(IDEA, kb, lexicalSimilarity)
    expect(report.alignment_tasks, '每个 idea 模块一个对齐任务').toHaveLength(2)
    const first = report.alignment_tasks[0]
    expect(first.idea_module.name).toBe('频域一致性约束')
    expect(first.candidates.map((candidate) => candidate.module_name)).toContain('频域一致性约束')
    // 判定权在专家：报告里没有 new/partial/known 这类结论字段
    expect(JSON.stringify(report)).not.toContain('"status"')
  })

  it('模块轴召回为空时也照样产出任务（"真新"与"措辞不同"要靠专家结合论文证据判断）', async () => {
    seedPaper(kb, '10.1/a')
    const report = await collide(IDEA, kb, lexicalSimilarity)
    const task = report.alignment_tasks.find((item) => item.idea_module.name === '原型对齐模块')
    expect(task, '即使库里没有对应模块，任务也要在').toBeDefined()
    expect(task.candidates).toEqual([])
  })


  it('候选排序按"被几轴命中 + 各轴排名"，不按相似度（相似度已证明不可信）', async () => {
    seedPaper(kb, '10.1/a')
    seedPaper(kb, '10.1/b', {
      problem: '实时性与算力开销', method: '轻量化主干替换',
      modules: [{ name: '轻量主干', role: '降算力', description: '用 MobileNet 替换', kind: 'backbone' }],
    })
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a', '10.1/b'], {})
    kb.upsertEntry('methods', '频域一致性约束 + 稀疏回放缓冲', ['10.1/a'], {})

    const report = await collide(IDEA, kb, lexicalSimilarity)
    // a 同时被问题轴与做法轴命中，应排在 b（只被问题轴命中）之前
    expect(report.candidates[0]).toBe('10.1/a')
  })

  it('专家上下文里**不出现任何相似度数字**（旧实现给裁判看 sim=0.012，等于用噪声锚定）', async () => {
    seedPaper(kb, '10.1/a')
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a'], {})
    kb.upsertModule({ name: '频域一致性约束', statement: '约束频谱响应一致性', kinds: ['loss'], paper_id: '10.1/a' })

    const report = await collide(IDEA, kb, lexicalSimilarity)
    const context = renderCollisionContext(report, IDEA)

    expect(context).not.toMatch(/sim\s*=/)
    expect(context).not.toMatch(/0\.\d{3}/)
    expect(context).not.toMatch(/相似度/)
    // 但材料要齐：idea 模块、论文全文、候选模块、命中轴
    expect(context).toContain('频域一致性约束')
    expect(context).toContain('命中轴')
    expect(context).toContain('库里已有的候选模块')
    expect(context).toContain('Paper 10.1/a')
  })

  it('未提取的候选论文：证据卡照样给出，并**明确标注**尚未提取', async () => {
    kb.upsertPaper({
      paper_id: '10.1/c', title: 'Paper C', authors: [], source_channel: 'asta',
      pdf_status: 'pending', created_at: NOW, updated_at: NOW,
    })
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/c'], {})

    const report = await collide(IDEA, kb, lexicalSimilarity)
    const card = report.evidence_cards.find((item) => item.paper_id === '10.1/c')
    expect(card.extraction).toBeUndefined()
    expect(renderCollisionContext(report, IDEA)).toContain('尚未提取')
  })

  it('没有任何候选时不崩：空轴、空卡片、空对齐任务', async () => {
    const report = await collide(IDEA, kb, lexicalSimilarity)
    expect(report.candidates).toEqual([])
    expect(report.evidence_cards).toEqual([])
    expect(report.alignment_tasks).toHaveLength(2)
    expect(renderCollisionContext(report, IDEA)).toContain('idea 的方法模块 2 个')
  })

  it('idea 没有模块时仍能跑（退回问题轴与做法轴）', async () => {
    seedPaper(kb, '10.1/a')
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a'], {})
    const noModules = { ...IDEA, method_modules: [] }
    const report = await collide(noModules, kb, lexicalSimilarity)
    expect(report.alignment_tasks).toEqual([])
    expect(report.candidates).toContain('10.1/a')
  })
})
