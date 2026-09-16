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

  // ── P3-1：检索面（迁移 v4 的 FTS5 trigram + LIKE 回退）────────────────────
  describe('search（FTS5 trigram + LIKE 回退）', () => {
    beforeEach(() => {
      tri.upsert('problems', '跨数据集与跨伪造手法的泛化：检测器在未见生成方法下性能下降', ['10.1/a', '10.1/b'], {
        'deepfake-detection': { modality: 'visual' },
      })
      tri.upsert('problems', '实时与轻量化部署：高精度检测器计算开销大', ['10.1/c'], {})
      tri.upsert('methods', 'WMamba：小波特征提取 + Mamba 主干', ['10.1/a'], {
        'deepfake-detection': { paradigm: 'hybrid' },
      })
      tri.upsert('innovations', '动态轮廓卷积（DCConv）：可学习偏移与自适应坐标轴', ['10.1/a'], {})
      tri.upsert('innovations', 'L2 特征归一化正则（L2-Norm）', ['10.1/d'], {})
    })

    it('英文 3 字符以上走 FTS5（大小写不敏感）', () => {
      const hits = tri.search({ query: 'mamba' })
      expect(hits.map((entry) => entry.entry_id)).toEqual(['M001'])
    })

    it('中文 3 字符以上命中（FTS5 trigram）', () => {
      const hits = tri.search({ query: '灾难性' })
      expect(hits).toHaveLength(0) // 语料里没有「灾难性」，负例先立住
      const positive = tri.search({ query: '泛化' })
      // 「泛化」只有 2 字 → 走 LIKE 回退；这正是必须保留回退路径的原因
      expect(positive.map((entry) => entry.entry_id)).toContain('P001')
      const tri3 = tri.search({ query: '生成方法' })
      expect(tri3.map((entry) => entry.entry_id)).toContain('P001')
    })

    it('2 字中文查询不回退成空结果（trigram 限制的兜底）', () => {
      const two = tri.search({ query: '部署' })
      expect(two.map((entry) => entry.entry_id)).toEqual(['P002'])
      const twoLatin = tri.search({ query: 'L2' })
      expect(twoLatin.map((entry) => entry.entry_id)).toEqual(['I002'])
    })

    it('store 过滤与 sourcePaper 过滤生效', () => {
      expect(tri.search({ store: 'innovations' }).every((entry) => entry.store === 'innovations')).toBe(true)
      const bySource = tri.search({ sourcePaper: '10.1/a' })
      expect(bySource.map((entry) => entry.entry_id).sort()).toEqual(['I001', 'M001', 'P001'])
      expect(tri.search({ sourcePaper: '10.1/不存在' })).toHaveLength(0)
    })

    it('空查询 = 列条目，limit 生效且封顶 200', () => {
      expect(tri.search({ store: 'problems' })).toHaveLength(2)
      expect(tri.search({ store: 'problems', limit: 1 })).toHaveLength(1)
    })

    it('FTS5 语法字符不会炸（查询串被当作短语，不解析为语法）', () => {
      expect(() => tri.search({ query: 'mamba OR NEAR("x") -y*' })).not.toThrow()
    })

    it('新增/更新条目立即可检索（触发器同步，不需要手工 rebuild）', () => {
      tri.upsert('methods', 'SFMFNet：空间-频率混合感知多尺度融合', ['10.1/e'], {})
      expect(tri.search({ query: 'SFMFNet' }).map((entry) => entry.entry_id)).toContain('M002')

      // 直接改基表（模拟 upsert 之外的任何写入路径）→ `_au` 触发器必须同时
      // 删旧词、加新词，否则索引会留下幽灵条目。注意不能靠 upsert 来测：
      // 归一化不同的 statement 会新建条目（这是去重语义，不是更新）。
      db.raw.prepare("UPDATE methods SET statement = ? WHERE entry_id = 'M002'")
        .run('Mamba 状态空间模型用于深伪检测')
      expect(tri.search({ query: 'Mamba' }).map((entry) => entry.entry_id)).toContain('M002')
      expect(tri.search({ query: 'SFMFNet' }).map((entry) => entry.entry_id)).not.toContain('M002')
    })

    it('summary 给出各库计数、总数与最近更新时间', () => {
      const summary = tri.summary()
      expect(summary.counts).toEqual({ problems: 2, methods: 1, innovations: 2 })
      expect(summary.total).toBe(5)
      expect(summary.latest_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })
})
