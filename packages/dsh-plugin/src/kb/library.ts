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
  type MethodModule,
  type PaperExtraction,
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

/** paper_extractions 表的 SQLite 行形态（JSON 列存字符串）。 */
interface PaperExtractionRow {
  paper_id: string
  problem_statement: string
  method_summary: string
  /** 迁移 v8 追加；旧行为 `'[]'`（读回时按"该字段不存在"处理）。 */
  method_modules?: string
  innovations: string
  future_work: string
  limitations: string
  benchmark: string
  metrics: string
  baseline_methods: string
  extraction_quality: 'full_text' | 'abstract_only'
  extracted_at: string
}

/**
 * 解析 `method_modules` 列：**空数组视为"该字段不存在"**。
 *
 * 为什么这么区分：迁移 v8 给旧行填 `'[]'`，而"这份提取早于该字段"与
 * "提取了但一个模块都没有"是两件事——前者要靠 `innovations` 兜底派生模块清单，
 * 后者说明 Reader 按要求返回了空列表。把它们混成一个空数组，调用方就无从判断。
 */
function parseMethodModules(raw: string | undefined): MethodModule[] | undefined {
  if (raw === undefined) return undefined
  const parsed = JSON.parse(raw) as MethodModule[]
  return parsed.length === 0 ? undefined : parsed
}

/** 行 ↔ 记录互转。 */
function rowToRecord(row: PaperRow): PaperRecord {  return {
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

  /**
   * **已解析但还没有结构化提取**的论文（P4-2 批量提取用）。
   *
   * 为什么由库里选而不是让模型报 id：模型报 id 会漏、会重复、会记错；
   * 而"哪些还没做"是一个**确定的查询**。库里还有 154 篇已解析未提取时，
   * 这个差集就是待办清单本身。
   *
   * @param limit - 最多返回几篇（正数）；不传返回全部。
   * @returns **新入库的优先**、再按 paper_id 稳定排序的 `{paper_id, title, md_path}`。
   *
   * 排序口径：`created_at DESC, paper_id`。为什么不纯按 paper_id：真实场景里
   * "本批新检索进来的 30 篇"往往比历史存量更急（用户 2026-09-17 的批次说明就是这么排的），
   * 而 paper_id 排序会把新批次打散在几百篇里。`created_at` 相同（同一批入库）时按 paper_id
   * 兜底，保证**同一状态下每次调用的顺序一致**——确定性是这个工具能被放心批量跑的前提。
   */
  listUnextracted(limit?: number): Array<{ paper_id: string; title: string; md_path: string }> {
    const sql = [
      'SELECT p.paper_id AS paper_id, p.title AS title, p.md_path AS md_path',
      'FROM papers p',
      'LEFT JOIN paper_extractions e ON e.paper_id = p.paper_id',
      "WHERE p.md_path IS NOT NULL AND p.md_path != '' AND e.paper_id IS NULL",
      'ORDER BY p.created_at DESC, p.paper_id ASC',
      limit === undefined ? '' : 'LIMIT ?',
    ].filter((part) => part !== '').join(' ')
    const rows = (limit === undefined
      ? this.db.raw.prepare(sql).all()
      : this.db.raw.prepare(sql).all(limit)) as Array<{ paper_id: string; title: string; md_path: string }>
    return rows
  }

  /** 已解析未提取的**篇数**（不把整批行读进内存）。 */
  countUnextracted(): number {
    const row = this.db.raw.prepare([
      'SELECT COUNT(*) AS c FROM papers p',
      'LEFT JOIN paper_extractions e ON e.paper_id = p.paper_id',
      "WHERE p.md_path IS NOT NULL AND p.md_path != '' AND e.paper_id IS NULL",
    ].join(' ')).get() as { c: number }
    return row.c
  }

  /** 按来源通道计数（审计用）。 */
  countByChannel(): Record<string, number> {
    const rows = this.db.raw
      .prepare('SELECT source_channel, COUNT(*) AS c FROM papers GROUP BY source_channel')
      .all() as Array<{ source_channel: string; c: number }>
    return Object.fromEntries(rows.map((row) => [row.source_channel, row.c]))
  }

  /**
   * 保存一篇论文的结构化提取（P2-6，v1.2 §5.3）。
   *
   * - 同 paper_id 再提取 = 覆盖（提取结果是该论文的当前权威快照，不是历史日志；
   *   需要历史时由会话日志承担）；
   * - 同步把 papers.extraction_quality 镜像为本次提取的质量标记（§5.3 语义）。
   */
  saveExtraction(extraction: PaperExtraction): void {
    this.db.raw
      .prepare(`
        INSERT INTO paper_extractions (
          paper_id, problem_statement, method_summary, method_modules, innovations, future_work,
          limitations, benchmark, metrics, baseline_methods, extraction_quality, extracted_at
        ) VALUES (
          @paper_id, @problem_statement, @method_summary, @method_modules, @innovations, @future_work,
          @limitations, @benchmark, @metrics, @baseline_methods, @extraction_quality, @extracted_at
        )
        ON CONFLICT(paper_id) DO UPDATE SET
          problem_statement = excluded.problem_statement,
          method_summary = excluded.method_summary,
          method_modules = excluded.method_modules,
          innovations = excluded.innovations,
          future_work = excluded.future_work,
          limitations = excluded.limitations,
          benchmark = excluded.benchmark,
          metrics = excluded.metrics,
          baseline_methods = excluded.baseline_methods,
          extraction_quality = excluded.extraction_quality,
          extracted_at = excluded.extracted_at
      `)
      .run({
        paper_id: extraction.paper_id,
        problem_statement: extraction.problem_statement,
        method_summary: extraction.method_summary,
        method_modules: JSON.stringify(extraction.method_modules ?? []),
        innovations: JSON.stringify(extraction.innovations),
        future_work: JSON.stringify(extraction.future_work),
        limitations: JSON.stringify(extraction.limitations),
        benchmark: JSON.stringify(extraction.benchmarks),
        metrics: JSON.stringify(extraction.metrics),
        baseline_methods: JSON.stringify(extraction.baseline_methods),
        extraction_quality: extraction.extraction_quality,
        extracted_at: extraction.extracted_at,
      })
    this.db.raw
      .prepare('UPDATE papers SET extraction_quality = ? WHERE paper_id = ?')
      .run(extraction.extraction_quality, extraction.paper_id)
  }

  /** 读取一篇论文的提取结果；不存在返回 undefined。 */
  getExtraction(paperId: string): PaperExtraction | undefined {
    const row = this.db.raw
      .prepare('SELECT * FROM paper_extractions WHERE paper_id = ?')
      .get(paperId) as PaperExtractionRow | undefined
    if (row === undefined) return undefined
    return {
      paper_id: row.paper_id,
      problem_statement: row.problem_statement,
      method_summary: row.method_summary,
      ...(parseMethodModules(row.method_modules) === undefined
        ? {}
        : { method_modules: parseMethodModules(row.method_modules) as MethodModule[] }),
      innovations: JSON.parse(row.innovations) as string[],
      future_work: JSON.parse(row.future_work) as string[],
      limitations: JSON.parse(row.limitations) as string[],
      benchmarks: JSON.parse(row.benchmark) as string[],
      metrics: JSON.parse(row.metrics) as string[],
      baseline_methods: JSON.parse(row.baseline_methods) as string[],
      extraction_quality: row.extraction_quality,
      extracted_at: row.extracted_at,
    }
  }

  /** 已提取的论文数。 */
  extractionCount(): number {
    return (this.db.raw.prepare('SELECT COUNT(*) AS c FROM paper_extractions').get() as { c: number }).c
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
