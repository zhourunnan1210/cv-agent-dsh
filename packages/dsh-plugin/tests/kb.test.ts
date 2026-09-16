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

import { PaperDatabase } from '../lib/kb/db.js'
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
    expect(db.appliedMigrations()).toEqual([1])
    db.close()
  })

  it('重复打开幂等（不重跑已应用版本）', () => {
    const path = join(dir, 'metadata.db')
    new PaperDatabase(path).close()
    const db = new PaperDatabase(path)
    expect(db.appliedMigrations()).toEqual([1])
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

  it('get 按未归一化写法也能命中（归一化在入口处统一）', () => {
    library.upsert(makePaper({}))
    expect(library.get('HTTPS://DOI.ORG/10.1000/example')?.paper_id).toBe('10.1000/example')
  })
})
