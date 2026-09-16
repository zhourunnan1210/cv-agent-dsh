/**
 * TriLibrary（三库写入）测试：ID 生成、statement 归一化去重合并、
 * source_papers 并集、ext 浅合并、跨库独立、计数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PaperDatabase } from '../lib/kb/db.js'
import { TriLibrary } from '../lib/kb/trilibrary.js'

describe('TriLibrary（§7.5.2 三库同构表）', () => {
  let dir: string
  let db: PaperDatabase
  let tri: TriLibrary

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cvagent-tri-'))
    db = new PaperDatabase(join(dir, 'metadata.db'))
    tri = new TriLibrary(db)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('首次写入按 P001/M001/I001 编号', () => {
    expect(tri.upsert('problems', '问题一', ['p1'], {}).entry_id).toBe('P001')
    expect(tri.upsert('methods', '方法一', ['p1'], {}).entry_id).toBe('M001')
    expect(tri.upsert('innovations', '创新一', ['p1'], {}).entry_id).toBe('I001')
    expect(tri.counts()).toEqual({ problems: 1, methods: 1, innovations: 1 })
  })

  it('同库 statement 归一化相等 → 合并：保留较长 statement、union 来源', () => {
    tri.upsert('problems', 'Cross-Dataset Deepfake Detection', ['10.1/a'], {})
    const outcome = tri.upsert('problems', 'cross dataset  deepfake-detection', ['10.2/b'], {})
    expect(outcome.merged).toBe(true)
    expect(outcome.entry_id).toBe('P001')
    const entry = tri.get('problems', 'P001')
    expect(entry?.statement).toBe('Cross-Dataset Deepfake Detection')
    expect(entry?.source_papers).toEqual(['10.1/a', '10.2/b'])
  })

  it('ext 浅合并：incoming 覆盖同键，base 其它键保留', () => {
    tri.upsert('methods', '方法X', ['p1'], { 'deepfake-detection': { backbone: 'Xception', paradigm: 'spatial-based' } })
    tri.upsert('methods', '方法X', ['p2'], { 'deepfake-detection': { paradigm: 'hybrid' } })
    const entry = tri.get('methods', 'M001')
    expect(entry?.ext).toEqual({ 'deepfake-detection': { backbone: 'Xception', paradigm: 'hybrid' } })
  })

  it('跨库独立：同一 statement 在 problems 与 methods 各自成行', () => {
    tri.upsert('problems', '同一句话', ['p1'], {})
    tri.upsert('methods', '同一句话', ['p1'], {})
    expect(tri.counts()).toEqual({ problems: 1, methods: 1, innovations: 0 })
    expect(tri.get('methods', 'M001')?.store).toBe('methods')
  })

  it('编号按最大数字后缀递增，不依赖计数', () => {
    tri.upsert('problems', '一', [], {})
    tri.upsert('problems', '二', [], {})
    tri.upsert('problems', '三', [], {})
    expect(tri.upsert('problems', '四', [], {}).entry_id).toBe('P004')
  })
})
