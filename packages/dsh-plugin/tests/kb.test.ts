/**
 * metadata.db 与论文库服务逻辑的集成测试（真实 SQLite 文件）。
 *
 * 覆盖：迁移框架（幂等、版本记录）、冻结 DDL 落库、upsert 三级去重键、
 * 合并规则（union authors / 保留较长 abstract / 不回退解析状态）、
 * 标题命中的 needs_review 行为（不自动合并）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PaperDatabase, MIGRATIONS } from '../lib/kb/db.js'
import { PaperLibrary } from '../lib/kb/library.js'
import type { PaperRecord } from '@cv-research/core'

const NOW = '2026-09-16T00:00:00Z'

function makePaper(overrides: Partial<PaperRecord>): PaperRecord {
  return {
    paper_id: '10.1000/example',
    title: 'Example Deepfake Detection Paper',
    authors: ['Alice'],
    source_channel: 'asta',
    pdf_status: 'pending',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

describe('PaperDatabase 迁移框架', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-kb-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('首次打开应用全部迁移并记录版本', () => {
    const db = new PaperDatabase(join(dir, 'metadata.db'))
    // 断言与冻结清单**同源**（而不是硬编码 [1,2,3]）：迁移纪律是「只追加新版本」，
    // 追加 v4/v5… 时这条测试应当自动跟随，而不是变成需要手改的绊脚石
    expect(db.appliedMigrations()).toEqual(MIGRATIONS.map((migration) => migration.version))
    expect(db.appliedMigrations()).toEqual([1, 2, 3, 4, 5])
    db.close()
  })

  it('重复打开幂等（不重跑已应用版本）', () => {
    const path = join(dir, 'metadata.db')
    new PaperDatabase(path).close()
    const db = new PaperDatabase(path)
    expect(db.appliedMigrations()).toEqual(MIGRATIONS.map((migration) => migration.version))
    db.close()
  })

  it('冻结 DDL 中的全部表与索引存在', () => {
    const db = new PaperDatabase(join(dir, 'metadata.db'))
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const expected of ['papers', 'problems', 'methods', 'innovations', 'domain_packs', 'project_pack_binding', 'schema_migrations']) {
      expect(tables).toContain(expected)
    }
    const indexes = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const expected of ['idx_papers_doi', 'idx_papers_arxiv', 'idx_papers_pmid', 'idx_papers_title', 'idx_papers_year']) {
      expect(indexes).toContain(expected)
    }
    // v4：三库 FTS5 影子表（`type='table'`）+ 每库三个同步触发器；v5：失败库同样一套
    for (const expected of ['problems_fts', 'methods_fts', 'innovations_fts', 'failures', 'failures_fts']) {
      expect(tables).toContain(expected)
    }
    const triggers = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const store of ['problems', 'methods', 'innovations', 'failures']) {
      for (const suffix of ['ai', 'ad', 'au']) {
        expect(triggers).toContain(`${store}_fts_${suffix}`)
      }
    }
    db.close()
  })
})

describe('PaperLibrary upsert（§7.5.2 去重与合并）', () => {
  let dir: string
  let db: PaperDatabase
  let library: PaperLibrary

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-lib-'))
    db = new PaperDatabase(join(dir, 'metadata.db'))
    library = new PaperLibrary(db)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('首次入库：inserted，channel 计数正确', () => {
    const outcome = library.upsert(makePaper({}))
    expect(outcome.inserted).toBe(true)
    expect(outcome.paper_id).toBe('10.1000/example')
    expect(library.count()).toBe(1)
    expect(library.countByChannel()).toEqual({ asta: 1 })
  })

  it('同 paper_id 再次入库：合并（union authors、保留较长 abstract、不回退状态）', () => {
    library.upsert(makePaper({
      authors: ['Alice'],
      abstract: 'A long abstract with many details.',
      pdf_status: 'downloaded',
    }))
    const outcome = library.upsert(makePaper({
      authors: ['Alice', 'Bob'],
      abstract: 'short',
      pdf_status: 'pending',
      citation_count: 42,
      updated_at: '2026-09-16T01:00:00Z',
    }))
    expect(outcome.inserted).toBe(false)
    expect(outcome.merged).toBe(true)
    expect(outcome.matched_kind).toBe('paper_id')
    expect(outcome.merged_into).toBe('10.1000/example')
    expect(library.count()).toBe(1)
    const merged = library.get('10.1000/example')
    expect(merged?.authors).toEqual(['Alice', 'Bob'])
    expect(merged?.abstract).toContain('long abstract')
    expect(merged?.pdf_status).toBe('downloaded')
    expect(merged?.citation_count).toBe(42)
    expect(merged?.updated_at).toBe('2026-09-16T01:00:00Z')
  })

  it('不同 paper_id 但同 doi：外部 ID 合并', () => {
    library.upsert(makePaper({ paper_id: 'local:abc', doi: '10.1000/example' }))
    // 候选不带 paper_id 命中，但 doi 相同（默认夹具不含 doi，需显式给出）
    const outcome = library.upsert(makePaper({ doi: '10.1000/example' }))
    expect(outcome.merged).toBe(true)
    expect(outcome.matched_kind).toBe('external_id')
    expect(outcome.merged_into).toBe('local:abc')
    expect(library.count()).toBe(1)
    // 合并发生在既有行上：PK 不漂移（mergePaperRecords 保留 base 的 paper_id）
    expect(library.get('local:abc')?.title).toBe('Example Deepfake Detection Paper')
  })

  it('标题命中：needs_review，不自动写库（冻结纪律）', () => {
    library.upsert(makePaper({ paper_id: 'local:abc', title: 'Example Deepfake Detection Paper' }))
    const outcome = library.upsert(makePaper({
      paper_id: '10.1000/other',
      title: 'Example  Deepfake-Detection Paper',
    }))
    expect(outcome.needs_review).toBe(true)
    expect(outcome.matched_kind).toBe('title')
    expect(outcome.merged_into).toBe('local:abc')
    expect(library.count()).toBe(1)
    expect(library.get('10.1000/other')).toBeUndefined()
  })

  it('迁移 v2 追加的 pdf_path 列可读写', () => {
    library.upsert(makePaper({ pdf_path: 'C:/Zotero/storage/ABC/x.pdf' }))
    const record = library.get('10.1000/example')
    expect(record?.pdf_path).toBe('C:/Zotero/storage/ABC/x.pdf')
    // 合并规则：既有 pdf_path 不被空值覆盖
    library.upsert(makePaper({}))
    expect(library.get('10.1000/example')?.pdf_path).toBe('C:/Zotero/storage/ABC/x.pdf')
  })

  it('迁移 v3：提取结果保存/读取往返，并镜像 papers.extraction_quality', () => {
    library.upsert(makePaper({}))
    const extraction = {
      paper_id: '10.1000/example',
      problem_statement: '提升跨数据集泛化的 deepfake 检测',
      method_summary: '多尺度空间-频率融合网络',
      innovations: ['新融合模块'],
      future_work: ['扩展到视频'],
      limitations: ['算力开销大'],
      benchmarks: ['FF++'],
      metrics: ['AUC'],
      baseline_methods: ['Xception'],
      extraction_quality: 'full_text',
      extracted_at: '2026-09-16T10:00:00Z',
    }
    library.saveExtraction(extraction)
    expect(library.extractionCount()).toBe(1)
    expect(library.getExtraction('10.1000/example')).toEqual(extraction)
    expect(library.get('10.1000/example')?.extraction_quality).toBe('full_text')

    // 覆盖语义：同 paper_id 再提取是当前权威快照
    library.saveExtraction({ ...extraction, method_summary: '更新后的方法', extracted_at: '2026-09-16T11:00:00Z' })
    expect(library.extractionCount()).toBe(1)
    expect(library.getExtraction('10.1000/example')?.method_summary).toBe('更新后的方法')
  })

  it('get 按未归一化写法也能命中（归一化在入口处统一）', () => {
    library.upsert(makePaper({}))
    expect(library.get('HTTPS://DOI.ORG/10.1000/example')?.paper_id).toBe('10.1000/example')
  })
})
