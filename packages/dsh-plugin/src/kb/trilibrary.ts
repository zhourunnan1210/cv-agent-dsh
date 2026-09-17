/**
 * 三库（problems / methods / innovations）的写入与读取（dsh 侧 SQLite 落地）。
 *
 * 依据：勘误 §7.5.2 冻结的三库同构表（entry_id / statement / ext JSON /
 * source_papers / 时间戳）。语义在 core（statement 归一化去重）；向量相似度
 * 去重在 Phase 3 选型后升级，本层接口不变。
 *
 * 合并规则（Phase 2，§17.2 的占位实现）：
 * - 同 store + statement 归一化完全相等 → 合并：保留较长 statement、
 *   union source_papers、ext 浅合并（incoming 覆盖同键）；
 * - 否则插入，entry_id 取当前 store 最大数字后缀 + 1（P001/M001/I001）。
 */

import { normalizeTitle, STORE_ID_PREFIX, STORE_NAMES, type ExtensionFields, type KbEntry, type StoreName, type UpsertOutcome } from '@cv-research/core'

import { PaperDatabase } from './db.js'

/** ID 前缀统一由 core 的 `STORE_ID_PREFIX` 提供（P/M/I/F），避免两处各写一份。 */
const ID_PREFIX = STORE_ID_PREFIX

interface EntryRow {
  entry_id: string
  statement: string
  ext: string
  source_papers: string
  created_at: string
  updated_at: string
}

/** `TriLibrary.search` 的查询参数。 */
export interface SearchOptions {
  /** 缺省搜索三个库。 */
  readonly store?: StoreName
  /** 关键词；≥3 字符走 FTS5 trigram，否则 LIKE 回退。空串表示只要过滤条件。 */
  readonly query?: string
  /** 每库最多返回条数（缺省 20，上限 200）。 */
  readonly limit?: number
  /** 只看「该论文作为来源之一」的条目。 */
  readonly sourcePaper?: string
}

/** 三库总览。 */
export interface TriLibrarySummary {
  readonly counts: Record<StoreName, number>
  readonly total: number
  readonly latest_updated_at: string | null
}

function rowToEntry(store: StoreName, row: EntryRow): KbEntry {
  const base = {
    entry_id: row.entry_id,
    statement: row.statement,
    ext: JSON.parse(row.ext) as ExtensionFields,
    source_papers: JSON.parse(row.source_papers) as string[],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  return { ...base, store } as KbEntry
}

/**
 * ext 合并：pack 级浅合并（同 pack 的字段字典逐键覆盖，不同 pack 并集）。
 * 顶层整体覆盖会把 base 的 pack 对象整个丢掉（L1 实测）。
 */
function mergeExt(base: ExtensionFields, incoming: ExtensionFields): ExtensionFields {
  const merged: Record<string, Record<string, unknown>> = { ...base }
  for (const [packId, fields] of Object.entries(incoming)) {
    merged[packId] = { ...(merged[packId] ?? {}), ...fields }
  }
  return merged
}

/** 三库写入服务。 */
export class TriLibrary {
  private readonly db: PaperDatabase

  constructor(db: PaperDatabase) {
    this.db = db
  }

  /**
   * 写入一条三库条目（store 为表名，固定枚举，无注入风险）。
   *
   * @returns 结果：created 新建 / merged 并入既有（merged_into 为被并入条目 ID）。
   */
  upsert(store: StoreName, statement: string, sourcePapers: readonly string[], ext: ExtensionFields): UpsertOutcome {
    const now = new Date().toISOString()
    const normalized = normalizeTitle(statement)

    // Phase 2 去重：同 store 内 statement 归一化相等 → 合并。
    const candidates = this.db.raw
      .prepare(`SELECT * FROM ${store}`)
      .all() as unknown as EntryRow[]
    for (const row of candidates) {
      if (normalizeTitle(row.statement) === normalized) {
        // 保留「归一化后字符更多」的 statement（原始字符数会被空白噪声骗，
        // L1 实测：'cross dataset  deepfake-detection' 原始更长却是噪声版）
        const baseNorm = normalizeTitle(row.statement).length
        const incomingNorm = normalized.length
        const mergedStatement = incomingNorm > baseNorm ? statement : row.statement
        const sources = [...JSON.parse(row.source_papers) as string[]]
        for (const paperId of sourcePapers) {
          if (!sources.includes(paperId)) sources.push(paperId)
        }
        const mergedExt = mergeExt(JSON.parse(row.ext) as ExtensionFields, ext)
        this.db.raw
          .prepare(`UPDATE ${store} SET statement = ?, ext = ?, source_papers = ?, updated_at = ? WHERE entry_id = ?`)
          .run(mergedStatement, JSON.stringify(mergedExt), JSON.stringify(sources), now, row.entry_id)
        return { entry_id: row.entry_id, merged: true, merged_into: row.entry_id }
      }
    }

    // 插入：ID 取最大数字后缀 + 1。
    const prefix = ID_PREFIX[store]
    const maxRow = this.db.raw
      .prepare(`SELECT entry_id FROM ${store} ORDER BY entry_id DESC LIMIT 1`)
      .get() as { entry_id: string } | undefined
    const maxNumber = maxRow === undefined ? 0 : Number(/\d+$/.exec(maxRow.entry_id)?.[0] ?? 0)
    const entryId = `${prefix}${String(maxNumber + 1).padStart(3, '0')}`
    this.db.raw
      .prepare(`INSERT INTO ${store} (entry_id, statement, ext, source_papers, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(entryId, statement, JSON.stringify(ext), JSON.stringify(sourcePapers), now, now)
    return { entry_id: entryId, merged: false }
  }

  get(store: StoreName, entryId: string): KbEntry | undefined {
    const row = this.db.raw
      .prepare(`SELECT * FROM ${store} WHERE entry_id = ?`)
      .get(entryId) as EntryRow | undefined
    return row === undefined ? undefined : rowToEntry(store, row)
  }

  /**
   * 三库检索（`cvagent_kb_search` 的底座）。
   *
   * 两条路径（S4 spike 的实测结论，见 db.ts 迁移 v4 注释）：
   * - 查询串 **≥3 字符** → FTS5 `MATCH`（trigram）。查询串整体当作一个短语，用双引号
   *   包住交给 FTS5，避免把 `-`/`OR`/`*` 之类当语法解析（用户/模型输入不可信）；
   * - 查询串 **<3 字符**（或 FTS5 报错）→ `LIKE '%…%'` 回退。trigram 索引查不到
   *   2 字中文，而「泛化」这类两字词恰恰是常用检索词。
   *
   * 过滤：store（缺省搜索三个库）、source_paper（该论文作为来源之一）。
   * 排序：命中相关性（FTS5 `rank`）优先，其次 entry_id；跨库时按 problems → methods
   * → innovations 分组返回，便于调用方按角色消费。
   */
  search(options: SearchOptions = {}): KbEntry[] {
    const stores: readonly StoreName[] = options.store === undefined
      ? STORE_NAMES
      : [options.store]
    const limit = options.limit === undefined || options.limit <= 0 ? 20 : Math.min(options.limit, 200)
    const query = options.query?.trim() ?? ''
    const results: KbEntry[] = []
    for (const store of stores) {
      const rows = this.searchOne(store, query, limit, options.sourcePaper)
      for (const row of rows) results.push(rowToEntry(store, row))
    }
    return results
  }

  private searchOne(store: StoreName, query: string, limit: number, sourcePaper: string | undefined): EntryRow[] {
    const filters: string[] = []
    const params: (string | number)[] = []
    // source_papers 是 JSON 数组文本；用带引号的片段匹配整元素，避免子串误命中
    if (sourcePaper !== undefined && sourcePaper !== '') {
      filters.push(`t.source_papers LIKE ?`)
      params.push(`%"${sourcePaper}"%`)
    }

    if (query !== '') {
      // ≥3 字符才走 FTS5（trigram 的下限）；否则 LIKE
      if ([...query].length >= 3) {
        const ftsQuery = `"${query.replace(/"/g, '""')}"`
        try {
          const where = [`${store}_fts MATCH ?`, ...filters]
          const rows = this.db.raw
            .prepare(`
              SELECT t.* FROM ${store} AS t
              JOIN ${store}_fts AS f ON f.rowid = t.rowid
              WHERE ${where.join(' AND ')}
              ORDER BY f.rank LIMIT ?
            `)
            .all(ftsQuery, ...params, limit) as unknown as EntryRow[]
          return rows
        } catch {
          // FTS5 不可用/语法异常 → 落到 LIKE（宁可慢一点，也不要静默空结果）
        }
      }
      filters.push(`t.statement LIKE ?`)
      params.push(`%${query}%`)
    }

    const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`
    return this.db.raw
      .prepare(`SELECT t.* FROM ${store} AS t ${where} ORDER BY t.entry_id LIMIT ?`)
      .all(...params, limit) as unknown as EntryRow[]
  }

  /** 各库条目数 + 最近更新时间（`cvagent_kb_summary` 的底座）。 */
  summary(): TriLibrarySummary {
    const counts = this.counts()
    const latest = this.db.raw
      .prepare(`
        SELECT MAX(updated_at) AS latest FROM (
          SELECT updated_at FROM problems UNION ALL
          SELECT updated_at FROM methods UNION ALL
          SELECT updated_at FROM innovations UNION ALL
          SELECT updated_at FROM failures
        )
      `)
      .get() as { latest: string | null }
    return {
      counts,
      total: STORE_NAMES.reduce((sum, store) => sum + counts[store], 0),
      latest_updated_at: latest.latest,
    }
  }

  /** 各库条目数。 */
  counts(): Record<StoreName, number> {
    return {
      problems: this.count('problems'),
      methods: this.count('methods'),
      innovations: this.count('innovations'),
      failures: this.count('failures'),
    }
  }

  private count(store: StoreName): number {
    return (this.db.raw.prepare(`SELECT COUNT(*) AS c FROM ${store}`).get() as { c: number }).c
  }
}
