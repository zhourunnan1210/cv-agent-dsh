/**
 * core 契约的**真实适配器**：把 sqlite 里的论文库 / 四库接成 `KnowledgeBase`。
 *
 * ## 为什么需要它
 *
 * core 在 v1.2 §10 声明了 `KnowledgeBase`，但在此之前**没有任何实现**——
 * dsh 侧的服务（`KbService`）是"按 store 取键"的另一套形状（`searchEntries({store, query})`、
 * `entrySummary()`）。两者语义相通但签名不同，于是 core 那份契约一直只是文档。
 *
 * `@cv-research/mcp` 的 S5 封装要的是 core 的接口，所以这里补上适配层：
 * **一个方向**（sqlite → core），不引入 dsh / Cordis 依赖，也不需要 Cordis 上下文——
 * `PaperDatabase` / `TriLibrary` 本身就是纯 Node。
 *
 * ## 相似度口径：故意与 dsh 侧一致
 *
 * `TriLibrary.search()` 只给命中行、不给分数（FTS5 的 `rank` 跨库不可比，见
 * `scoring/service.ts` 的注释）。所以这里用 core 的 `lexicalSimilarity(query, statement)`
 * 现算——**与 `ideaScore.retrieve()` 用的是同一个函数**。这一点是刻意的：
 * 同一个问题在 dsh 里问和在 MCP 客户端里问，必须得到同一批候选、同一个分数，
 * 否则"两套实现迟早分叉"。
 *
 * 因为估的是字符 trigram Jaccard，`mode` 一律如实标 `keyword_only`——
 * 不是向量检索就不要说自己是（v1.2 §19 降级矩阵）。
 *
 * ## 只读
 *
 * 四个 `upsert*` 一律抛错。写路径必须走 dsh 侧的工具层，那里有 §7.5.2 的去重键规则
 * （paper_id / doi / 标题归一化）与合并语义；让外部 MCP 客户端直接写库，
 * 等于绕过那套规则，制造出"库里有两份同一条目"的分叉。
 *
 * @module cv-agent-dsh/mcp
 */

import {
  lexicalSimilarity,
  type FailureEntry,
  type InnovationEntry,
  type KbEntry,
  type KbSummary,
  type KnowledgeBase,
  type MethodEntry,
  type ProblemEntry,
  type RetrievalResult,
  type ScoredEntry,
  type StoreName,
  type UpsertOutcome,
} from '@cv-research/core'

import { PaperDatabase } from '../kb/db.js'
import { TriLibrary } from '../kb/trilibrary.js'

export interface KnowledgeBaseAdapter {
  readonly kb: KnowledgeBase
  /** 关闭底层 sqlite 连接（Windows 下不关会让目录删不掉）。 */
  close(): void
}

/** 撞车召回默认取多少条（与 `ScoringThresholds.topk` 同量级）。 */
const DEFAULT_TOPK = 5

/**
 * 打开一个只读的 `KnowledgeBase`。
 *
 * @param options.dbPath - `metadata.db` 路径。
 * @returns 适配器实例；用完调 `close()`。
 */
export function createCoreKnowledgeBase(options: { dbPath: string }): KnowledgeBaseAdapter {
  const database = new PaperDatabase(options.dbPath)
  const entries = new TriLibrary(database)

  /** 一次库内检索 → core 的 `RetrievalResult`。 */
  const retrieve = <TEntry extends KbEntry>(store: StoreName, query: string, k: number): RetrievalResult<TEntry> => {
    const limit = Number.isFinite(k) && k > 0 ? Math.min(200, Math.trunc(k)) : DEFAULT_TOPK
    const rows = entries.search({ store, query, limit })
    const hits: ScoredEntry<TEntry>[] = rows
      .map((entry) => ({
        entry: entry as TEntry,
        // 与 dsh 侧 retrieve() 同一个函数：两处口径必须一致
        score: lexicalSimilarity(query, entry.statement),
      }))
      .sort((left, right) => right.score - left.score)
    return { mode: 'keyword_only', hits }
  }

  /** 只读适配器：写路径必须走 dsh 工具层（见文件头说明）。 */
  const readOnly = (operation: string): never => {
    throw new Error(
      `${operation} 在本适配器里不可用：` +
      '写路径必须走 dsh 侧的工具层（cvagent_kb_upsert_entry 等），那里有去重键与合并规则；' +
      '外部客户端直接写库会绕过它们。',
    )
  }

  const kb: KnowledgeBase = {
    upsertProblem: async (_entry: ProblemEntry): Promise<UpsertOutcome> => readOnly('upsertProblem'),
    upsertMethod: async (_entry: MethodEntry): Promise<UpsertOutcome> => readOnly('upsertMethod'),
    upsertInnovation: async (_entry: InnovationEntry): Promise<UpsertOutcome> => readOnly('upsertInnovation'),
    upsertFailure: async (_entry: FailureEntry): Promise<UpsertOutcome> => readOnly('upsertFailure'),

    similarProblems: async (query, k) => retrieve<ProblemEntry>('problems', query, k),
    similarMethods: async (query, k) => retrieve<MethodEntry>('methods', query, k),
    similarFailures: async (query, k) => retrieve<FailureEntry>('failures', query, k),

    summarize: async (limit): Promise<KbSummary> => {
      const perStore = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.trunc(limit)) : DEFAULT_TOPK
      const counts = entries.counts()
      /** 每库取前 N 条（空查询 = 全量按 entry_id 稳定序，见 TriLibrary.searchOne 的 LIKE 回退）。 */
      const top = (store: StoreName): KbEntry[] => entries.search({ store, limit: perStore })
      return {
        counts,
        problems: top('problems') as ProblemEntry[],
        methods: top('methods') as MethodEntry[],
        innovations: top('innovations') as InnovationEntry[],
        failures: top('failures') as FailureEntry[],
      }
    },
  }

  let closed = false
  return {
    kb,
    close() {
      // 幂等：入口脚本把 close 挂在 SIGINT/SIGTERM 两个信号上，重复触发或
      // 正常退出后再来一次都不该抛（底层 `PaperDatabase.close()` 第二次会抛
      // "database is not open"，而在信号处理器里抛错只会掩盖真正的退出原因）。
      if (closed) return
      closed = true
      database.close()
    },
  }
}
