import { describe, expect, it } from 'vitest'

import {
  dedupeMatch,
  mergePaperRecords,
  normalizePaperId,
  normalizeTitle,
  type PaperRecord,
} from '../src/schema/paper.js'

const NOW_OLD = '2026-09-01T00:00:00Z'
const NOW_NEW = '2026-09-16T00:00:00Z'

function makePaper(overrides: Partial<PaperRecord>): PaperRecord {
  return {
    paper_id: '10.1000/example',
    title: 'Example Deepfake Detection Paper',
    authors: ['Alice'],
    source_channel: 'asta',
    pdf_status: 'pending',
    created_at: NOW_OLD,
    updated_at: NOW_OLD,
    ...overrides,
  }
}

describe('normalizePaperId（§7.5.2 去重键第 1 级）', () => {
  it('DOI 各种写法归一为同一键', () => {
    const keys = [
      '10.1000/EXAMPLE',
      'https://doi.org/10.1000/example',
      'http://dx.doi.org/10.1000/example',
      'doi: 10.1000/example',
    ].map((value) => normalizePaperId(value))
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('10.1000/example')
  })

  it('arXiv 各种写法归一为同一键', () => {
    const keys = [
      'arXiv:1706.03762',
      'ARXIV:1706.03762',
      'https://arxiv.org/abs/1706.03762',
      'https://arxiv.org/pdf/1706.03762.pdf',
      '1706.03762',
    ].map((value) => normalizePaperId(value))
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('1706.03762')
  })
})

describe('normalizeTitle', () => {
  it('大小写、标点、空白折叠为同一键', () => {
    const a = normalizeTitle('Deepfake Detection: A Survey of Methods')
    const b = normalizeTitle('  deepfake-detection——a survey of methods!! ')
    expect(a).toBe(b)
  })
})

describe('dedupeMatch 优先级（paper_id → 外部 ID → 标题线索）', () => {
  it('paper_id 命中优先于其它', () => {
    const existing = [
      makePaper({ paper_id: '10.1000/example', doi: '10.9999/other', title: 'Totally Different Title' }),
    ]
    const match = dedupeMatch(makePaper({}), existing)
    expect(match?.kind).toBe('paper_id')
    expect(match?.existing.paper_id).toBe('10.1000/example')
  })

  it('paper_id 未命中时按外部 ID（doi）命中', () => {
    const existing = [
      makePaper({ paper_id: 'local:abc', doi: '10.1000/example', title: 'Something Else' }),
    ]
    // 候选与既有记录 paper_id 不同，但 doi 相同（默认夹具不含 doi，需显式给出）
    const match = dedupeMatch(
      makePaper({ paper_id: '10.1000/other', doi: '10.1000/example' }),
      existing,
    )
    expect(match?.kind).toBe('external_id')
    expect(match?.existing.paper_id).toBe('local:abc')
  })

  it('外部 ID 也未命中时按标题归一化命中（复核级）', () => {
    const existing = [
      makePaper({ paper_id: 'local:abc', title: 'Example Deepfake Detection Paper' }),
    ]
    const match = dedupeMatch(
      makePaper({ paper_id: '10.1000/other', title: 'Example  Deepfake-Detection Paper' }),
      existing,
    )
    expect(match?.kind).toBe('title')
  })
})

describe('mergePaperRecords（§7.5.2 合并规则）', () => {
  it('保留较长 abstract、union authors、不回退 pdf_status、保留 created_at', () => {
    const base = makePaper({
      paper_id: '10.1000/example',
      authors: ['Alice'],
      abstract: 'A long abstract with many details about the method and results.',
      pdf_status: 'downloaded',
      created_at: NOW_OLD,
      updated_at: NOW_OLD,
    })
    const incoming = makePaper({
      paper_id: '10.1000/example',
      authors: ['Alice', 'Bob'],
      abstract: 'short',
      pdf_status: 'pending',
      citation_count: 42,
      updated_at: NOW_NEW,
    })
    const merged = mergePaperRecords(base, incoming)
    expect(merged.abstract).toBe(base.abstract)
    expect(merged.authors).toEqual(['Alice', 'Bob'])
    expect(merged.pdf_status).toBe('downloaded')
    expect(merged.citation_count).toBe(42)
    expect(merged.created_at).toBe(NOW_OLD)
    expect(merged.updated_at).toBe(NOW_NEW)
  })
})
