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

import { normalizeTitle, type ExtensionFields, type KbEntry, type StoreName, type UpsertOutcome } from '@cv-research/core'

import { PaperDatabase } from './db.js'

const ID_PREFIX: Record<StoreName, string> = {
  problems: 'P',
  methods: 'M',
  innovations: 'I',
}

interface EntryRow {
  entry_id: string
  statement: string
  ext: string
  source_papers: string
  created_at: string
  updated_at: string
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

  /** 各库条目数。 */
  counts(): Record<StoreName, number> {
    return {
      problems: this.count('problems'),
      methods: this.count('methods'),
      innovations: this.count('innovations'),
    }
  }

  private count(store: StoreName): number {
    return (this.db.raw.prepare(`SELECT COUNT(*) AS c FROM ${store}`).get() as { c: number }).c
  }
}
