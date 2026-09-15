/**
 * 三库基础 schema（平台无关）。
 *
 * 设计依据：v1.2 文档 §5.4 与 §17.1。
 *
 * 关键约定（对应 v1.2 §3.4 的 Domain Pack 机制）：
 * 三库条目 = **基础字段** + **领域扩展字段**。基础字段跨领域通用，写死在这里；
 * 领域扩展字段（如 Deepfake 的 `detection_target`、`paradigm`）一律走 `ext` 列，
 * 由 Domain Pack 的 `schema-ext.yml` 声明。因此本文件**不得**出现
 * `face_swap`、`FF++` 之类的领域字面量（v1.2 原则六）。
 */

/** 三库的库名。 */
export type StoreName = 'problems' | 'methods' | 'innovations'

/** 所有库名，供遍历与校验使用。 */
export const STORE_NAMES = ['problems', 'methods', 'innovations'] as const satisfies readonly StoreName[]

/**
 * 领域扩展字段的载荷。
 *
 * 按领域命名空间隔离（v1.2 §3.4.4）：键为 Domain Pack 的 pack_id，
 * 值为该 pack 的字段字典。这样同一份条目可同时服务多个领域包。
 *
 * @example
 * ```ts
 * const ext: ExtensionFields = {
 *   'deepfake-detection': { detection_target: 'face_swap', modality: 'video' },
 * }
 * ```
 */
export type ExtensionFields = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/** 三库条目的公共基础字段。 */
export interface BaseEntry {
  /** 主键，形如 `P001` / `M001` / `I001`（v1.2 §5.4）。 */
  readonly entry_id: string
  /** 条目的自然语言陈述。对应各库的 `problem_statement` / `method_name` / `innovation_statement`。 */
  readonly statement: string
  /** 领域扩展字段，按 pack 命名空间隔离。 */
  readonly ext: ExtensionFields
  /** 来源论文 ID 数组（DOI 或 arXiv ID，规范化小写）。 */
  readonly source_papers: readonly string[]
  /** ISO 8601 时间戳。 */
  readonly created_at: string
  /** ISO 8601 时间戳。 */
  readonly updated_at: string
}

/** 问题库条目。 */
export interface ProblemEntry extends BaseEntry {
  readonly store: 'problems'
}

/** 方法库条目。 */
export interface MethodEntry extends BaseEntry {
  readonly store: 'methods'
}

/** 创新点库条目。 */
export interface InnovationEntry extends BaseEntry {
  readonly store: 'innovations'
}

/** 任一条目。 */
export type KbEntry = ProblemEntry | MethodEntry | InnovationEntry

/** 带相似度的检索命中。 */
export interface ScoredEntry<TEntry extends KbEntry = KbEntry> {
  readonly entry: TEntry
  /** 相似度，语义由检索后端决定（向量余弦或 BM25 分数）。 */
  readonly score: number
}

/**
 * 检索降级标记（v1.2 §19 降级矩阵）。
 *
 * 向量服务不可用时三库检索降级为关键词匹配，此时结果必须携带该标记，
 * 以免下游把降级结果当作等价的向量检索结论。
 */
export type RetrievalMode = 'vector' | 'keyword_only'

/** 一次检索的结果，携带降级信息。 */
export interface RetrievalResult<TEntry extends KbEntry = KbEntry> {
  readonly mode: RetrievalMode
  readonly hits: readonly ScoredEntry<TEntry>[]
}

/** 三库摘要，供 Idea 生成使用（v1.2 §6.1，每库上限 N 条以防上下文溢出）。 */
export interface KbSummary {
  readonly counts: Readonly<Record<StoreName, number>>
  readonly problems: readonly ProblemEntry[]
  readonly methods: readonly MethodEntry[]
  readonly innovations: readonly InnovationEntry[]
}

/**
 * 知识库服务接口（v1.2 §10）。
 *
 * 实现落在 `packages/dsh-plugin`；本文件只声明契约，不含任何 dsh / Cordis 依赖。
 */
export interface KnowledgeBase {
  upsertProblem(entry: ProblemEntry): Promise<UpsertOutcome>
  upsertMethod(entry: MethodEntry): Promise<UpsertOutcome>
  upsertInnovation(entry: InnovationEntry): Promise<UpsertOutcome>
  /** 向量检索；向量不可用时降级为关键词匹配并如实标记 `mode`。 */
  similarProblems(query: string, k: number): Promise<RetrievalResult<ProblemEntry>>
  similarMethods(query: string, k: number): Promise<RetrievalResult<MethodEntry>>
  /** 三库摘要，供 Idea 生成。 */
  summarize(limit: number): Promise<KbSummary>
}

/**
 * 写入结果。
 *
 * `merged` 为真表示未新建条目，而是并入了已有条目（v1.2 §17.2：先按向量相似度
 * 超阈值找候选，再由 Analyst 判断是否同一条目；合并时保留较长 statement、
 * union `source_papers`）。
 */
export interface UpsertOutcome {
  readonly entry_id: string
  readonly merged: boolean
  /** 合并时的被并入条目 ID，便于审计。 */
  readonly merged_into?: string
}
