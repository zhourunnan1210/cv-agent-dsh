/**
 * 论文库服务逻辑：papers 表的 upsert（规范化 + 去重键 + 合并规则）。
 *
 * 依据：勘误 §7.5.2 冻结的去重键优先级与合并规则。
 * 纯判定在 `@cv-research/core`（dedupeMatch / mergePaperRecords），
 * 本文件负责把判定落到 SQLite。
 */

import {
  dedupeMatch,
  mergePaperRecords,
  normalizePaperId,
  type PaperRecord,
} from '@cv-research/core'

import { PaperDatabase } from './db.js'
import type { PaperRow } from './db.js'

/** upsert 的结果（供工具与调用方审计）。 */
export interface UpsertPaperOutcome {
  /** 归一化后的 paper_id。 */
  readonly paper_id: string
  /** 是否新建了行。 */
  readonly inserted: boolean
  /** 是否合并进既有行（paper_id / 外部 ID 命中）。 */
  readonly merged: boolean
  /** 命中的去重键级别；无命中时为 null。 */
  readonly matched_kind: 'paper_id' | 'external_id' | 'title' | null
  /** 合并目标（既有行的 paper_id）；未合并时为 null。 */
  readonly merged_into: string | null
  /** 标题级命中（§7.5.2：人工复核线索，不自动合并）时的提示。 */
  readonly needs_review: boolean
}

/** 行 ↔ 记录互转。 */
function rowToRecord(row: PaperRow): PaperRecord {
  return {
    paper_id: row.paper_id,
    title: row.title,
    authors: JSON.parse(row.authors) as string[],
    ...(row.year === null ? {} : { year: row.year }),
    ...(row.venue === null ? {} : { venue: row.venue }),
    ...(row.citation_count === null ? {} : { citation_count: row.citation_count }),
    ...(row.doi === null ? {} : { doi: row.doi }),
    ...(row.arxiv_id === null ? {} : { arxiv_id: row.arxiv_id }),
    ...(row.pmid === null ? {} : { pmid: row.pmid }),
    ...(row.url === null ? {} : { url: row.url }),
    ...(row.oa_pdf_url === null ? {} : { oa_pdf_url: row.oa_pdf_url }),
    ...(row.abstract === null ? {} : { abstract: row.abstract }),
    source_channel: row.source_channel,
    pdf_status: row.pdf_status,
    ...(row.parse_channel === null ? {} : { parse_channel: row.parse_channel }),
    ...(row.extraction_quality === null ? {} : { extraction_quality: row.extraction_quality }),
    ...(row.md_path === null ? {} : { md_path: row.md_path }),
    ...(row.pdf_path === null ? {} : { pdf_path: row.pdf_path }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

const UPSERT_SQL = `
  INSERT INTO papers (
    paper_id, title, authors, year, venue, citation_count, doi, arxiv_id, pmid,
    url, oa_pdf_url, abstract, source_channel, pdf_status, parse_channel,
    extraction_quality, md_path, pdf_path, created_at, updated_at
  ) VALUES (
    @paper_id, @title, @authors, @year, @venue, @citation_count, @doi, @arxiv_id, @pmid,
    @url, @oa_pdf_url, @abstract, @source_channel, @pdf_status, @parse_channel,
    @extraction_quality, @md_path, @pdf_path, @created_at, @updated_at
  )
`

/** 论文库。 */
export class PaperLibrary {
  private readonly db: PaperDatabase

  constructor(db: PaperDatabase) {
    this.db = db
  }

  /**
   * 入库一条论文记录（§7.5.2 去重键）：
   * paper_id / 外部 ID 命中 → 合并（mergePaperRecords）；标题命中 → **不写库**，
   * 返回 `needs_review` 交由调用方（Analyst / 主 Agent）复核；无命中 → 插入。
   */
  upsert(record: PaperRecord): UpsertPaperOutcome {
    const paperId = normalizePaperId(record.paper_id)

    // 候选集：精确 ID + 外部 ID + 全表标题（Phase 2 规模下全扫可行；
    // Phase 3 引入嵌入后标题匹配升级为向量/BM25）。
    const byId = this.db.raw
      .prepare('SELECT * FROM papers WHERE paper_id = ?')
      .get(paperId) as PaperRow | undefined
    const external: PaperRow[] = []
    for (const [column, value] of [
      ['doi', record.doi],
      ['arxiv_id', record.arxiv_id],
      ['pmid', record.pmid],
    ] as const) {
      if (value === undefined) continue
      const row = this.db.raw
        .prepare(`SELECT * FROM papers WHERE ${column} = ? AND paper_id != ?`)
        .get(normalizePaperId(value), paperId) as PaperRow | undefined
      if (row !== undefined && !external.some((candidate) => candidate.paper_id === row.paper_id)) {
        external.push(row)
      }
    }
    const allRows = this.db.raw.prepare('SELECT * FROM papers').all() as unknown as PaperRow[]

    const existingRecords = [
      ...(byId === undefined ? [] : [rowToRecord(byId)]),
      ...external.map((row) => rowToRecord(row)),
      ...allRows
        .filter((row) => row.paper_id !== paperId && !external.some((candidate) => candidate.paper_id === row.paper_id))
        .map((row) => rowToRecord(row)),
    ]

    const match = dedupeMatch(record, existingRecords)

    if (match === undefined) {
      this.insert(record, paperId)
      return { paper_id: paperId, inserted: true, merged: false, matched_kind: null, merged_into: null, needs_review: false }
    }

    if (match.kind === 'title') {
      // 冻结纪律：标题命中不自动合并，只报告复核线索。
      return {
        paper_id: paperId,
        inserted: false,
        merged: false,
        matched_kind: 'title',
        merged_into: match.existing.paper_id,
        needs_review: true,
      }
    }

    const merged = mergePaperRecords(match.existing, record)
    this.update(merged)
    return {
      paper_id: paperId,
      inserted: false,
      merged: true,
      matched_kind: match.kind,
      merged_into: match.existing.paper_id,
      needs_review: false,
    }
  }

  /** 按归一化 paper_id 读取；不存在返回 undefined。 */
  get(paperId: string): PaperRecord | undefined {
    const row = this.db.raw
      .prepare('SELECT * FROM papers WHERE paper_id = ?')
      .get(normalizePaperId(paperId)) as PaperRow | undefined
    return row === undefined ? undefined : rowToRecord(row)
  }

  count(): number {
    return (this.db.raw.prepare('SELECT COUNT(*) AS c FROM papers').get() as { c: number }).c
  }

  /** 按来源通道计数（审计用）。 */
  countByChannel(): Record<string, number> {
    const rows = this.db.raw
      .prepare('SELECT source_channel, COUNT(*) AS c FROM papers GROUP BY source_channel')
      .all() as Array<{ source_channel: string; c: number }>
    return Object.fromEntries(rows.map((row) => [row.source_channel, row.c]))
  }

  private insert(record: PaperRecord, paperId: string): void {
    this.db.raw.prepare(UPSERT_SQL).run(this.bindings(record, paperId))
  }

  private update(record: PaperRecord): void {
    // node:sqlite 会拒绝 SQL 中未出现的命名参数；created_at 合并时保留 base 值，
    // 不在 UPDATE 里出现，故从这里剔除。
    const { created_at: _createdAt, ...bindings } = this.bindings(record, record.paper_id)
    this.db.raw
      .prepare(`
        UPDATE papers SET
          title = @title, authors = @authors, year = @year, venue = @venue,
          citation_count = @citation_count, doi = @doi, arxiv_id = @arxiv_id,
          pmid = @pmid, url = @url, oa_pdf_url = @oa_pdf_url, abstract = @abstract,
          source_channel = @source_channel, pdf_status = @pdf_status,
          parse_channel = @parse_channel, extraction_quality = @extraction_quality,
          md_path = @md_path, pdf_path = @pdf_path, updated_at = @updated_at
        WHERE paper_id = @paper_id
      `)
      .run(bindings)
  }

  /** 把记录映射为命名参数（authors JSON 化；可选字段 → null）。 */
  private bindings(record: PaperRecord, paperId: string) {
    return {
      paper_id: paperId,
      title: record.title,
      authors: JSON.stringify(record.authors),
      year: record.year ?? null,
      venue: record.venue ?? null,
      citation_count: record.citation_count ?? null,
      doi: record.doi ?? null,
      arxiv_id: record.arxiv_id ?? null,
      pmid: record.pmid ?? null,
      url: record.url ?? null,
      oa_pdf_url: record.oa_pdf_url ?? null,
      abstract: record.abstract ?? null,
      source_channel: record.source_channel,
      pdf_status: record.pdf_status,
      parse_channel: record.parse_channel ?? null,
      extraction_quality: record.extraction_quality ?? null,
      md_path: record.md_path ?? null,
      pdf_path: record.pdf_path ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
    }
  }
}
