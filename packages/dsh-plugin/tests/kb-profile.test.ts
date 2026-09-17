/**
 * 论文画像与反向索引（整合设计 v1.0 §3.4）的测试。
 *
 * 这一层要解决的是**结构缺陷**：此前 `source_papers` 是单向指针，
 * "取一篇论文在库里的完整信息"要扫四张表——而撞车链路要**每篇候选论文一张卡**。
 *
 * 所以测试重点不是"方法能跑"，而是三件结构性质：
 * 1. **索引与 source_papers 永远一致**（新建、合并新增来源两条路径都要覆盖）；
 * 2. **迁移回填无损且幂等**（对既有库执行 v6，不丢任何关联）；
 * 3. **画像能区分"没提取"与"提取了但字段为空"**（`undefined` vs 空值——
 *    这个区别决定了证据卡上写"该论文尚未提取"还是写一张空卡）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { KbService } from '../lib/kb/service.js'
import { MIGRATIONS } from '../lib/kb/db.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + '@deepseek-ai/dsh-system-prompt/package.json')
const systemPromptModule = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(
  pathToFileURL(createRequire(DSH + '@deepseek-ai/cordis/package.json').resolve('@deepseek-ai/cordis')).href
)

const NOW = '2026-09-17T00:00:00Z'

describe('论文画像与反向索引', () => {
  let dir
  let kb

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-profile-'))
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
    kb.upsertPaper({
      paper_id: '10.1/b', title: 'Paper B', authors: [], source_channel: 'asta',
      pdf_status: 'downloaded', md_path: 'markdown/10.1/b/full.md', parse_channel: 'mineru',
      created_at: NOW, updated_at: NOW,
    })
    kb.saveExtraction({
      paper_id: '10.1/a',
      problem_statement: '跨数据集泛化不足',
      method_summary: '频域分支 + CLIP 适配器',
      innovations: ['频域一致性损失'],
      future_work: [],
      limitations: ['噪声环境退化'],
      benchmarks: ['FaceForensics++ (FF++)'],
      metrics: ['AUC'],
      baseline_methods: ['Xception'],
      extraction_quality: 'full_text',
      extracted_at: NOW,
    })
  })

  afterEach(async () => {
    kb?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('画像三层齐全：L1 元数据 + L2 提取 + L3 分组条目', () => {
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a', '10.1/b'], { 'demo': { modality: 'visual' } })
    kb.upsertEntry('methods', '频域分支 + CLIP 适配器', ['10.1/a'], { 'demo': { paradigm: 'hybrid' } })

    const profile = kb.getPaperProfile('10.1/a')
    expect(profile.paper_id).toBe('10.1/a')
    expect(profile.meta.title).toBe('Paper A')
    expect(profile.extraction?.problem_statement).toBe('跨数据集泛化不足')
    expect(profile.entries.methods.map((entry) => entry.entry_id)).toEqual(['M001'])
    expect(profile.entries.problems.map((entry) => entry.entry_id)).toEqual(['P001'])
    expect(profile.entry_total).toBe(2)
  })

  it('shared_with 区分"本篇独有"与"多篇共享"（决定这条目能不能代表该论文）', () => {
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a', '10.1/b'], {})   // 2 篇共享 → shared_with = 1
    kb.upsertEntry('methods', '频域分支 + CLIP 适配器', ['10.1/a'], {})       // 本篇独有 → shared_with = 0

    const profile = kb.getPaperProfile('10.1/a')
    expect(profile.entries.problems[0].shared_with, '2 篇共享 → 除本篇外还有 1 篇').toBe(1)
    expect(profile.entries.methods[0].shared_with, '本篇独有 → 0').toBe(0)
  })

  it('未提取的论文：extraction 是 undefined，而不是空对象', () => {
    const profile = kb.getPaperProfile('10.1/b')
    expect(profile.extraction, '"没提取"必须能与"提取了但字段为空"区分').toBeUndefined()
    expect('extraction' in profile).toBe(false)
  })

  it('不存在的论文返回 undefined（调用方据此报错，而不是拿到空画像）', () => {
    expect(kb.getPaperProfile('10.9999/nope')).toBeUndefined()
  })

  it('反向索引随写入维护：新建条目会写索引', () => {
    kb.upsertEntry('innovations', '频域一致性损失', ['10.1/a'], {})
    const rows = kb.database.raw.prepare('SELECT paper_id, store, entry_id FROM entry_sources').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ paper_id: '10.1/a', store: 'innovations', entry_id: 'I001' })
  })

  it('反向索引随**合并**维护：并进来的新来源论文也要补进索引', () => {
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a'], {})
    expect(kb.entriesOfPaper('10.1/b', 'problems'), '合并前 b 还没关联').toHaveLength(0)
    // 同一条陈述再写一次 → 命中归一化去重 → 合并，且来源论文并集加入 b
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/b'], {})
    expect(kb.entriesOfPaper('10.1/b', 'problems').map((entry) => entry.entry_id)).toEqual(['P001'])
    expect(kb.papersSharingProblem('P001').sort()).toEqual(['10.1/a', '10.1/b'])
  })

  it('papersSharingProblem：问题簇展开（撞车"问题轴"的原语）', () => {
    kb.upsertEntry('problems', '跨数据集泛化不足', ['10.1/a', '10.1/b'], {})
    expect(kb.papersSharingProblem('P001').sort()).toEqual(['10.1/a', '10.1/b'])
    expect(kb.papersSharingProblem('P999'), '不存在的条目返回空数组而不是抛错').toEqual([])
  })

  /**
   * 迁移 v6 的回填：**对既有库执行时必须无损，且可重复执行**。
   *
   * 这是整个改动里最危险的一步——它要动的是用户库里 226 条真实关联。
   * 所以这里模拟"升级前的库"（有 source_papers、没有索引行），执行回填 SQL，
   * 断言关联一条不少；再执行一次，断言幂等。
   */
  it('迁移 v6 的回填无损且幂等（INSERT OR IGNORE + json_each）', () => {
    kb.upsertEntry('problems', '问题一', ['10.1/a', '10.1/b'], {})
    kb.upsertEntry('methods', '方法一', ['10.1/a'], {})
    kb.upsertEntry('innovations', '创新一', ['10.1/a'], {})
    kb.upsertEntry('failures', '失败一', ['10.1/b'], {})

    const backfill = MIGRATIONS.find((migration) => migration.version === 6).up
    // 造出"升级前"的状态：清空索引，只留 source_papers
    kb.database.raw.prepare('DELETE FROM entry_sources').run()
    expect(kb.database.raw.prepare('SELECT COUNT(*) AS c FROM entry_sources').get().c).toBe(0)

    kb.database.raw.exec(backfill)
    const afterFirst = kb.database.raw.prepare('SELECT COUNT(*) AS c FROM entry_sources').get().c
    expect(afterFirst, '2 + 1 + 1 + 1 = 5 条关联').toBe(5)

    kb.database.raw.exec(backfill)  // 幂等
    expect(kb.database.raw.prepare('SELECT COUNT(*) AS c FROM entry_sources').get().c).toBe(5)

    // 回填出的关联必须与 source_papers 逐条一致
    const profile = kb.getPaperProfile('10.1/a')
    expect(profile.entries.problems).toHaveLength(1)
    expect(profile.entries.methods).toHaveLength(1)
    expect(profile.entries.innovations).toHaveLength(1)
    expect(profile.entries.failures).toHaveLength(0)
  })

  it('entriesOfPaper 缺省查四个库，也可指定单库', () => {
    kb.upsertEntry('problems', '问题一', ['10.1/a'], {})
    kb.upsertEntry('methods', '方法一', ['10.1/a'], {})
    expect(kb.entriesOfPaper('10.1/a')).toHaveLength(2)
    expect(kb.entriesOfPaper('10.1/a', 'methods').map((entry) => entry.entry_id)).toEqual(['M001'])
  })
})
