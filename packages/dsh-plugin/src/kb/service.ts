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

import type { ExtensionFields, KbEntry, PaperExtraction, PaperRecord, StoreName } from '@cv-research/core'

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
  countByChannel(): Record<string, number>
  saveExtraction(extraction: PaperExtraction): void
  getExtraction(paperId: string): PaperExtraction | undefined
  extractionCount(): number
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

  countByChannel(): Record<string, number> {
    return this.library.countByChannel()
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

  /** 关闭数据库（unload / 测试用；Cordis 卸载时由 effect 处置）。 */
  close(): void {
    this.database.close()
  }
}

/** 默认导出：loader 按 `module.default` 取插件类（E18-②）。 */
export default KbService
