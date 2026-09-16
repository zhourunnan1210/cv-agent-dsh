/**
 * Reader 结构化提取的契约（平台无关）。
 *
 * 依据：v1.2 §5.3 的十字段提取表 + §5.3 的 `extraction_quality` 语义。
 * 本契约是 Reader 子代理 `outputSchema` 的直接来源（勘误 §4.1/§4.2）：
 * 委派时 outputSchema 用本类型编译，子代理只能按此结构应答。
 */

/** 提取通道质量（§5.3：由提取通道自动标记）。 */
export type ExtractionQuality = 'full_text' | 'abstract_only'

/** 单篇论文的结构化提取结果。 */
export interface PaperExtraction {
  /** 论文 ID（与 papers.paper_id 一致，DOI / arXiv / local:<key>）。 */
  readonly paper_id: string
  /** 解决的问题（Abstract + Introduction）。 */
  readonly problem_statement: string
  /** 方法概述（Method 章节）。 */
  readonly method_summary: string
  /** 创新点列表（Introduction + Conclusion）。 */
  readonly innovations: readonly string[]
  /** 未来研究方向（Conclusion + Discussion）。 */
  readonly future_work: readonly string[]
  /** 暴露的问题（Limitations + 批判性分析）。 */
  readonly limitations: readonly string[]
  /** 使用的数据集（Experiments 章节）。 */
  readonly benchmarks: readonly string[]
  /** 报告的指标（Experiments 章节）。 */
  readonly metrics: readonly string[]
  /** 对比方法（Experiments 章节）。 */
  readonly baseline_methods: readonly string[]
  /** 提取通道质量标记。 */
  readonly extraction_quality: ExtractionQuality
  /** ISO 时间戳。 */
  readonly extracted_at: string
}

/**
 * Reader 子代理的 outputSchema 字段名清单（顺序即 prompt 里呈现的顺序）。
 *
 * 用途：dsh 侧把本契约编译为 JSON Schema 传给 outputSchema；
 * 名字变更属于破坏性契约变更（子代理历史不可回放），要走迁移审查。
 */
export const EXTRACTION_FIELDS = [
  'problem_statement',
  'method_summary',
  'innovations',
  'future_work',
  'limitations',
  'benchmarks',
  'metrics',
  'baseline_methods',
  'extraction_quality',
] as const
