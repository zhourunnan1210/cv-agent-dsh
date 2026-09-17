/**
 * `kb` 服务（dsh 侧）：论文库（papers 表）的 Cordis Service 封装。
 *
 * 服务平面归属已裁定（勘误 §4.4.1，2026-09-15 决策记录）：
 * `kb` 是**项目私有**数据（两个会话可跑两个课题），走 preset + `isolate` realm。
 * 组合文件里本行与所有消费者（`cv-agent-dsh/kb-tools` 等）必须同处一个
 * `isolate: { kb: true }` 的 group。
 *
 * 本服务只做一件事：把 `@cv-research/core` 的去重/合并判定落到
 * `metadata.db`（PaperDatabase + PaperLibrary）。语义在 core，I/O 在本层。
 *
 * @module cv-agent-dsh/kb
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { STORE_NAMES, type ExtensionFields, type KbEntry, type PaperExtraction, type PaperRecord, type StoreName } from '@cv-research/core'

import { PaperDatabase } from './db.js'
import { PaperLibrary } from './library.js'
import type { UpsertPaperOutcome } from './library.js'
import { TriLibrary } from './trilibrary.js'
import type { SearchOptions, TriLibrarySummary } from './trilibrary.js'

/** 三库写入结果（带 store，便于工具层直接回显）。 */
export interface UpsertEntryOutcome {
  readonly entry_id: string
  readonly merged: boolean
  readonly merged_into?: string
  readonly store: StoreName
}

/** 三库检索参数（与 TriLibrary.search 同形，服务层不改语义）。 */
export type EntrySearchOptions = SearchOptions

/** 三库总览。 */
export type EntrySummary = TriLibrarySummary

/** 插件配置。 */
export interface Config {
  /** metadata.db 路径；缺省相对进程 cwd 的 `data/papers/metadata.db`（§5.2 布局）。 */
  dbPath?: string
}

export const Config = Schema.object({
  dbPath: Schema.string().default('data/papers/metadata.db').description('metadata.db 文件路径。'),
})

type ResolvedConfig = Required<Config>

/**
 * 解析配置默认值（E19：Loader 对不带 config 的行传 undefined，默认值必须显式落定）。
 */
export function resolveKbConfig(config: Config | undefined): ResolvedConfig {
  return {
    dbPath: config?.dbPath ?? 'data/papers/metadata.db',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kb: KbService
  }
}

/** Cordis 插件名。 */
export const name = 'cvagent-kb'

/** kb 服务的对外接口（工具行与本层测试都只看这一面）。 */
export interface KbApi {
  upsertPaper(record: PaperRecord): UpsertPaperOutcome
  getPaper(paperId: string): PaperRecord | undefined
  count(): number
  /** 已解析全文的论文数（阶段判据用）。 */
  parsedCount(): number
  countByChannel(): Record<string, number>
  saveExtraction(extraction: PaperExtraction): void
  getExtraction(paperId: string): PaperExtraction | undefined
  extractionCount(): number
  /** 已解析但未提取的论文（批量提取的待办来源，P4-2）。 */
  listUnextracted(limit?: number): Array<{ paper_id: string; title: string; md_path: string }>
  /** 已解析未提取的篇数。 */
  unextractedCount(): number
  upsertEntry(store: StoreName, statement: string, sourcePapers: readonly string[], ext: ExtensionFields): UpsertEntryOutcome
  searchEntries(options?: EntrySearchOptions): KbEntry[]
  getEntry(store: StoreName, entryId: string): KbEntry | undefined
  entrySummary(): EntrySummary
}

export class KbService extends Service implements KbApi {
  static inject = []

  private readonly library: PaperLibrary
  private readonly entries: TriLibrary
  private readonly database: PaperDatabase

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'kb')
    const resolved = resolveKbConfig(config)
    this.database = new PaperDatabase(resolved.dbPath)
    this.library = new PaperLibrary(this.database)
    this.entries = new TriLibrary(this.database)
  }

  upsertPaper(record: PaperRecord): UpsertPaperOutcome {
    return this.library.upsert(record)
  }

  getPaper(paperId: string): PaperRecord | undefined {
    return this.library.get(paperId)
  }

  count(): number {
    return this.library.count()
  }

  /**
   * 已解析全文的论文数（`md_path` 非空）。
   *
   * 用途：阶段判据（`knowledge_building` 要求"已解析 ≥ N 篇"）。补这个方法之前，
   * 判据里 `parsed` 永远是 0——门控会**永远无法达标**，而表面上一切正常。
   */
  parsedCount(): number {
    return (this.database.raw
      .prepare("SELECT COUNT(*) AS c FROM papers WHERE md_path IS NOT NULL AND md_path != ''")
      .get() as { c: number }).c
  }

  countByChannel(): Record<string, number> {
    return this.library.countByChannel()
  }

  /**
   * 已解析但还没有结构化提取的论文（P4-2 批量提取的待办来源）。
   *
   * 存在的理由见 `library.ts#listUnextracted`：让模型自己报 id 一定会漏/重/错，
   * 而这是确定的查询。库里长期存在"已解析 154 / 已提取 21"这种缺口时，
   * 它就是提取环节的待办清单。
   */
  listUnextracted(limit?: number): Array<{ paper_id: string; title: string; md_path: string }> {
    return this.library.listUnextracted(limit)
  }

  /** 已解析未提取的篇数（判据与摘要用）。 */
  unextractedCount(): number {
    return this.library.countUnextracted()
  }

  saveExtraction(extraction: PaperExtraction): void {
    this.library.saveExtraction(extraction)
  }

  getExtraction(paperId: string): PaperExtraction | undefined {
    return this.library.getExtraction(paperId)
  }

  extractionCount(): number {
    return this.library.extractionCount()
  }

  upsertEntry(store: StoreName, statement: string, sourcePapers: readonly string[], ext: ExtensionFields): UpsertEntryOutcome {
    const outcome = this.entries.upsert(store, statement, sourcePapers, ext)
    return { ...outcome, store }
  }

  searchEntries(options: EntrySearchOptions = {}): KbEntry[] {
    return this.entries.search(options)
  }

  getEntry(store: StoreName, entryId: string): KbEntry | undefined {
    return this.entries.get(store, entryId)
  }

  entrySummary(): EntrySummary {
    return this.entries.summary()
  }

  // ── Domain Pack 派生所需的原始视图（P3-5）─────────────────────────────────
  //
  // 为什么放在 kb 服务上：pack 的派生要读「论文 + 提取 + 四库条目」，这些正是
  // 本项目数据库的内容。让工具层自己写 SQL 会把表结构泄漏到工具里，也会绕过
  // 服务层的一致性约定。

  /** 论文库的轻量行（派生 pack 只需 id / 标题 / 年份 / 出处）。 */
  listPapersForPack(): { paper_id: string; title: string; year: number | null; venue: string | null }[] {
    return this.database.raw
      .prepare('SELECT paper_id, title, year, venue FROM papers ORDER BY paper_id')
      .all() as unknown as { paper_id: string; title: string; year: number | null; venue: string | null }[]
  }

  /** 全部提取结果（pack 的 benchmarks / metrics 频次从这里来）。 */
  listExtractions(): PaperExtraction[] {
    return this.database.raw
      .prepare('SELECT paper_id FROM paper_extractions ORDER BY paper_id')
      .all()
      .map((row) => this.library.getExtraction((row as { paper_id: string }).paper_id))
      .filter((extraction): extraction is PaperExtraction => extraction !== undefined)
  }

  /** 四库全部条目（pack 的 schema_ext 从真实 ext 用法反推）。 */
  listEntries(): { entry_id: string; store: StoreName; statement: string; ext: ExtensionFields }[] {
    const out: { entry_id: string; store: StoreName; statement: string; ext: ExtensionFields }[] = []
    for (const store of STORE_NAMES) {
      const rows = this.database.raw
        .prepare(`SELECT entry_id, statement, ext FROM ${store} ORDER BY entry_id`)
        .all() as unknown as { entry_id: string; statement: string; ext: string }[]
      for (const row of rows) {
        out.push({ entry_id: row.entry_id, store, statement: row.statement, ext: JSON.parse(row.ext) as ExtensionFields })
      }
    }
    return out
  }

  // ── Domain Pack 注册表（迁移 v1 的 domain_packs / project_pack_binding）─────
  //
  // 同样放在 kb 服务上：这两张表就在 metadata.db 里，且注册表写入必须与 pack 落盘
  // 在**同一处**发生，否则会出现"文件在、注册表没有"（或反之）的分叉。

  /** 登记一个已冻结的 pack（幂等：同 pack_id+version 覆盖登记信息）。 */
  registerDomainPack(frozen: { ref: { pack_id: string; version: string }; frozen_by: string; frozen_at: string }, packPath: string): void {
    this.database.raw
      .prepare('INSERT OR REPLACE INTO domain_packs (pack_id, version, frozen_by, frozen_at, pack_path) VALUES (?, ?, ?, ?, ?)')
      .run(frozen.ref.pack_id, frozen.ref.version, frozen.frozen_by, frozen.frozen_at, packPath)
  }

  /** 已登记的 pack 列表。 */
  listDomainPacks(): { pack_id: string; version: string; frozen_by: string; frozen_at: string; pack_path: string }[] {
    return this.database.raw
      .prepare('SELECT pack_id, version, frozen_by, frozen_at, pack_path FROM domain_packs ORDER BY pack_id, version')
      .all() as unknown as { pack_id: string; version: string; frozen_by: string; frozen_at: string; pack_path: string }[]
  }

  /** 项目 → pack 版本绑定（同一项目只绑一个版本，重复绑定即改绑）。 */
  bindProjectPack(projectId: string, packId: string, version: string): void {
    this.database.raw
      .prepare('INSERT OR REPLACE INTO project_pack_binding (project_id, pack_id, version) VALUES (?, ?, ?)')
      .run(projectId, packId, version)
  }

  /** 读取项目当前绑定的 pack（未绑定返回 undefined）。 */
  getProjectPackBinding(projectId: string): { pack_id: string; version: string } | undefined {
    return this.database.raw
      .prepare('SELECT pack_id, version FROM project_pack_binding WHERE project_id = ?')
      .get(projectId) as { pack_id: string; version: string } | undefined
  }

  /** 关闭数据库（unload / 测试用；Cordis 卸载时由 effect 处置）。 */
  close(): void {
    this.database.close()
  }
}

/** 默认导出：loader 按 `module.default` 取插件类（E18-②）。 */
export default KbService
