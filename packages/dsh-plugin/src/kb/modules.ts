/**
 * 模块清单（整合设计 v1.0 §3.5）：逐模块撞车的**对齐对象**。
 *
 * ## 这一层解决什么
 *
 * 旧机制只能回答"整体像不像"，而且是用字符重合度算的。但论文是**复杂的方法集合**，
 * 最常见的撞车形态是"你的 3 个模块里，有 2 个库里已经有了"——**旧机制无法表达它**。
 *
 * 要表达，库里就得有一份可对齐的模块清单：每条 = 一个可命名的机制
 * （`name` + `statement`）+ 谁用过它（`origin_papers`）+ 它从哪来（`origin_innovations`）。
 *
 * ## 归一与合并：为什么不能只按名字去重
 *
 * 模块名是 Analyst/Reader 自由命名的（"频域一致性约束" / "频率一致性损失" /
 * "frequency consistency loss"）。同一机制会有多个写法，只按字符串相等去重会
 * 把同一个机制拆成三条——**而撞车最怕的就是"库里明明有，却没对齐上"**。
 *
 * 因此合并用**两级**：
 * 1. **归一化名相等** → 直接合并（确定，零成本）；
 * 2. 归一化名不同 → 返回**候选列表**给调用方（Analyst），由它判定是否同一机制。
 *    这里**不自己做语义判断**：本层是确定性层，语义判断属于 LLM（§11.3 的分工）。
 *
 * ## 与 `innovations` 的区别
 *
 * `innovations` = 一篇论文的**增量**（归属论文）；`modules` = 跨论文的**机制族**（归属机制）。
 * 同一条 innovation 只属于一篇论文，同一个模块可以有多篇来源。
 *
 * @module cv-agent-dsh/kb-modules
 */

import { normalizeTitle } from '@cv-research/core'

import type { PaperDatabase } from './db.js'
import { compileFtsQuery } from './trilibrary.js'

/** 模块类别（与 `MethodModule.kind` 同源，便于两端对齐）。 */
export type ModuleKind =
  | 'backbone' | 'module' | 'loss' | 'training_strategy' | 'dataset' | 'protocol' | 'other'

export interface ModuleRecord {
  readonly module_id: string
  readonly name: string
  readonly statement: string
  readonly kinds: readonly ModuleKind[]
  readonly origin_papers: readonly string[]
  /** 派生它的 L3 innovations 条目（可追溯链）。 */
  readonly origin_innovations: readonly string[]
  readonly ext: Record<string, unknown>
  readonly created_at: string
  readonly updated_at: string
}

/** 写入请求：`module_id` 由本层分配；同一机制重复写入即合并。 */
export interface ModuleUpsert {
  readonly name: string
  readonly statement: string
  readonly kinds?: readonly ModuleKind[]
  readonly paper_id?: string
  readonly innovation_id?: string
  readonly ext?: Record<string, unknown>
}

export interface ModuleUpsertOutcome {
  readonly module_id: string
  readonly merged: boolean
  /** 合并时：并入了哪条已有模块。 */
  readonly merged_into?: string
  /** 归一化名不同但可能同一机制的候选（交给 Analyst 判定，本层不做语义判断）。 */
  readonly candidates: readonly { module_id: string; name: string; statement: string }[]
}

interface ModuleRow {
  module_id: string
  name: string
  statement: string
  kinds: string
  origin_papers: string
  origin_innovations: string
  ext: string
  created_at: string
  updated_at: string
}

function rowToModule(row: ModuleRow): ModuleRecord {
  return {
    module_id: row.module_id,
    name: row.name,
    statement: row.statement,
    kinds: JSON.parse(row.kinds) as ModuleKind[],
    origin_papers: JSON.parse(row.origin_papers) as string[],
    origin_innovations: JSON.parse(row.origin_innovations) as string[],
    ext: JSON.parse(row.ext) as Record<string, unknown>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** 模块名归一：与条目 statement 同一套（小写、去非字母数字、压缩空白）。 */
function normalizeModuleName(name: string): string {
  return normalizeTitle(name)
}

export class ModuleLibrary {
  constructor(private readonly db: PaperDatabase) {}

  count(): number {
    return (this.db.raw.prepare('SELECT COUNT(*) AS c FROM modules').get() as { c: number }).c
  }

  get(moduleId: string): ModuleRecord | undefined {
    const row = this.db.raw.prepare('SELECT * FROM modules WHERE module_id = ?').get(moduleId) as ModuleRow | undefined
    return row === undefined ? undefined : rowToModule(row)
  }

  /** 某篇论文贡献的模块。 */
  modulesOfPaper(paperId: string): ModuleRecord[] {
    return (this.db.raw
      .prepare('SELECT module_id FROM module_sources WHERE paper_id = ? ORDER BY module_id')
      .all(paperId) as unknown as { module_id: string }[])
      .map((row) => this.get(row.module_id))
      .filter((module): module is ModuleRecord => module !== undefined)
  }

  /** 用了某个模块的全部论文（撞车"模块轴"展开用）。 */
  papersOfModule(moduleId: string): string[] {
    return (this.db.raw
      .prepare('SELECT paper_id FROM module_sources WHERE module_id = ? ORDER BY paper_id')
      .all(moduleId) as unknown as { paper_id: string }[]).map((row) => row.paper_id)
  }

  /**
   * 写入一个模块：归一化名命中已有模块即**合并**，否则新建。
   *
   * 合并语义与四库条目一致：来源论文取并集、`origin_innovations` 取并集、
   * `statement` 保留**归一化后更长**的那条（更完整），`kinds` 取并集。
   */
  upsert(input: ModuleUpsert): ModuleUpsertOutcome {
    const now = new Date().toISOString()
    const normalized = normalizeModuleName(input.name)
    if (normalized === '') throw new Error('模块名不能为空')

    const existing = this.findByNormalizedName(normalized)
    if (existing !== undefined) {
      const papers = new Set(existing.origin_papers)
      if (input.paper_id !== undefined) papers.add(input.paper_id)
      const innovations = new Set(existing.origin_innovations)
      if (input.innovation_id !== undefined) innovations.add(input.innovation_id)
      const kinds = [...new Set([...existing.kinds, ...(input.kinds ?? [])])]
      const keepIncoming = normalizeModuleName(input.statement).length > normalizeModuleName(existing.statement).length
      this.db.raw
        .prepare('UPDATE modules SET statement = ?, kinds = ?, origin_papers = ?, origin_innovations = ?, updated_at = ? WHERE module_id = ?')
        .run(
          keepIncoming ? input.statement : existing.statement,
          JSON.stringify(kinds),
          JSON.stringify([...papers]),
          JSON.stringify([...innovations]),
          now,
          existing.module_id,
        )
      if (input.paper_id !== undefined) this.linkSource(input.paper_id, existing.module_id)
      return { module_id: existing.module_id, merged: true, merged_into: existing.module_id, candidates: [] }
    }

    const moduleId = this.nextId()
    this.db.raw
      .prepare('INSERT INTO modules (module_id, name, statement, kinds, origin_papers, origin_innovations, ext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        moduleId,
        input.name.trim(),
        input.statement,
        JSON.stringify(input.kinds ?? []),
        JSON.stringify(input.paper_id === undefined ? [] : [input.paper_id]),
        JSON.stringify(input.innovation_id === undefined ? [] : [input.innovation_id]),
        JSON.stringify(input.ext ?? {}),
        now,
        now,
      )
    if (input.paper_id !== undefined) this.linkSource(input.paper_id, moduleId)
    return { module_id: moduleId, merged: false, candidates: this.similarCandidates(input.name, moduleId) }
  }

  /**
   * 检索模块（撞车"模块轴"的入口）。
   *
   * 两条路径与四库同源：FTS5 trigram `MATCH`，命中为空或查询过短则回退 LIKE。
   * 排序按 bm25（FTS 路径），LIKE 路径按 module_id——**确定性优先**，
   * 语义排序留给后续的 embedding（§8 的 P3）。
   */
  search(options: { query?: string; kinds?: readonly ModuleKind[]; paperId?: string; limit?: number } = {}): ModuleRecord[] {
    const limit = options.limit === undefined || options.limit <= 0 ? 20 : Math.min(options.limit, 200)
    const query = options.query?.trim() ?? ''
    let rows: ModuleRow[]
    if (query === '') {
      rows = this.db.raw.prepare('SELECT * FROM modules ORDER BY module_id LIMIT ?').all(limit) as unknown as ModuleRow[]
    } else {
      rows = this.searchFts(query, limit)
      if (rows.length === 0) rows = this.searchLike(query, limit)
    }
    let modules = rows.map(rowToModule)
    if (options.kinds !== undefined && options.kinds.length > 0) {
      modules = modules.filter((module) => module.kinds.some((kind) => options.kinds?.includes(kind)))
    }
    if (options.paperId !== undefined) {
      modules = modules.filter((module) => module.origin_papers.includes(options.paperId as string))
    }
    return modules.slice(0, limit)
  }

  /**
   * FTS5 路径：查询编译**复用四库那一份**（`compileFtsQuery`）。
   *
   * ⚠️ 这里曾经自己写了一份更差的：把长中文查询整体当一个短语 `"频率一致性损失"`，
   * 于是「频率一致性损失」永远匹配不到「频域一致性约束」（尽管两者共享「一致性」）。
   * 而 `compileFtsQuery` 早就解决了这件事——它把 CJK 连续段切成 3 字滑窗、词项间 OR，
   * 并且丢掉 <3 字符的项由 LIKE 兜底。
   * **同一个子系统里的第二份实现，就是又一次"两份实现迟早分叉"。**
   */
  private searchFts(query: string, limit: number): ModuleRow[] {
    const match = compileFtsQuery(query)
    if (match === undefined) return []
    try {
      return this.db.raw
        .prepare('SELECT m.* FROM modules_fts f JOIN modules m ON m.rowid = f.rowid WHERE modules_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(match, limit) as unknown as ModuleRow[]
    } catch {
      return []
    }
  }

  private searchLike(query: string, limit: number): ModuleRow[] {
    return this.db.raw
      .prepare('SELECT * FROM modules WHERE name LIKE ? OR statement LIKE ? ORDER BY module_id LIMIT ?')
      .all(`%${query}%`, `%${query}%`, limit) as unknown as ModuleRow[]
  }

  private findByNormalizedName(normalized: string): ModuleRecord | undefined {
    // 归一化在 TS 侧做（SQL 里没有等价的归一函数）；模块量级（数百条）下全扫可接受，
    // 与四库条目去重同一套做法——两份实现才是要避免的。
    for (const row of this.db.raw.prepare('SELECT * FROM modules').all() as unknown as ModuleRow[]) {
      if (normalizeModuleName(row.name) === normalized) return rowToModule(row)
    }
    return undefined
  }

  /**
   * 归一化名不同、但可能同一机制的候选（**只召回，不判定**）。
   *
   * ⚠️ 用**原始模块名**去检索，不能用归一化串：归一化会把标点压成空格、把大小写抹平，
   * 而库里存的是原始名——拿归一化串去查 FTS/LIKE 永远命中不到（第一次跑就是 0 候选）。
   * 归一化只用于**精确合并判定**，不用于召回。
   *
   * 是否同一机制由 Analyst 定，本层不越界（§11.3：语义判断属 LLM）。
   */
  private similarCandidates(rawName: string, excludeId: string): { module_id: string; name: string; statement: string }[] {
    return this.search({ query: rawName, limit: 6 })
      .filter((module) => module.module_id !== excludeId)
      .map((module) => ({ module_id: module.module_id, name: module.name, statement: module.statement }))
  }

  /** 合并两条模块（Analyst 判定为同一机制时调用）。 */
  merge(fromId: string, intoId: string): ModuleRecord {
    const from = this.get(fromId)
    const into = this.get(intoId)
    if (from === undefined) throw new Error(`模块不存在：${fromId}`)
    if (into === undefined) throw new Error(`模块不存在：${intoId}`)
    const now = new Date().toISOString()
    const papers = [...new Set([...into.origin_papers, ...from.origin_papers])]
    const innovations = [...new Set([...into.origin_innovations, ...from.origin_innovations])]
    const kinds = [...new Set([...into.kinds, ...from.kinds])]
    const statement = normalizeModuleName(from.statement).length > normalizeModuleName(into.statement).length
      ? from.statement
      : into.statement
    this.db.raw
      .prepare('UPDATE modules SET statement = ?, kinds = ?, origin_papers = ?, origin_innovations = ?, updated_at = ? WHERE module_id = ?')
      .run(statement, JSON.stringify(kinds), JSON.stringify(papers), JSON.stringify(innovations), now, intoId)
    // 来源表与派生链都改指到保留的那条
    this.db.raw.prepare('UPDATE OR IGNORE module_sources SET module_id = ? WHERE module_id = ?').run(intoId, fromId)
    this.db.raw.prepare('DELETE FROM module_sources WHERE module_id = ?').run(fromId)
    this.db.raw.prepare('DELETE FROM modules WHERE module_id = ?').run(fromId)
    const merged = this.get(intoId)
    if (merged === undefined) throw new Error('合并后模块消失（不应发生）')
    return merged
  }

  private linkSource(paperId: string, moduleId: string): void {
    this.db.raw
      .prepare('INSERT OR IGNORE INTO module_sources (paper_id, module_id) VALUES (?, ?)')
      .run(paperId, moduleId)
  }

  private nextId(): string {
    const row = this.db.raw.prepare('SELECT module_id FROM modules ORDER BY module_id DESC LIMIT 1').get() as { module_id: string } | undefined
    const max = row === undefined ? 0 : Number(/\d+$/.exec(row.module_id)?.[0] ?? 0)
    return `MOD${String(max + 1).padStart(3, '0')}`
  }
}
