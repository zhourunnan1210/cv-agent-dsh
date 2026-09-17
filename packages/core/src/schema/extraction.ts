/**
 * Reader 结构化提取的契约（平台无关）。
 *
 * 依据：v1.2 §5.3 的十字段提取表 + §5.3 的 `extraction_quality` 语义。
 * 本契约是 Reader 子代理 `outputSchema` 的直接来源（勘误 §4.1/§4.2）：
 * 委派时 outputSchema 用本类型编译，子代理只能按此结构应答。
 */

/** 提取通道质量（§5.3：由提取通道自动标记）。 */
export type ExtractionQuality = 'full_text' | 'abstract_only'

/** 模块类别（用于结构检索；与库侧 `ModuleKind` 同源）。 */
export type MethodModuleKind =
  | 'backbone' | 'module' | 'loss' | 'training_strategy' | 'dataset' | 'protocol' | 'other'

/**
 * 方法的一个**组成模块**（整合设计 v1.0 §3.2）。
 *
 * 与 `innovations` 的分工（这是本设计的关键区分）：
 * - `method_modules` 表达方法的**组成**（含标准件，如"用 Xception 主干"）→ **撞车的对齐对象**；
 * - `innovations` 表达该论文的**增量**（可命名的机制）→ 新颖性判断与 idea 生成的素材。
 *
 * 撞车问的是"你的这个模块，库里有没有人做过"——问的是**组成**，不是增量。
 */
export interface MethodModule {
  /** 可命名的模块名（如「频域一致性约束」「稀疏回放缓冲」）。 */
  readonly name: string
  /** 一句话：它在整体方法里干什么。 */
  readonly role: string
  /** 一段：输入是什么、做了什么操作、起什么作用（粒度见 `GRANULARITY.module_description`）。 */
  readonly description: string
  readonly kind: MethodModuleKind
}

/** 单篇论文的结构化提取结果。 */
export interface PaperExtraction {
  /** 论文 ID（与 papers.paper_id 一致，DOI / arXiv / local:<key>）。 */
  readonly paper_id: string
  /** 解决的问题（Abstract + Introduction）。 */
  readonly problem_statement: string
  /** 方法概述（Method 章节）。 */
  readonly method_summary: string
  /**
   * 方法组成模块（整合设计 v1.0 新增）。
   *
   * **可选**：21 篇早期提取没有这个字段（设计 §10 开放项 4 裁定不重提取）。
   * 缺省 `undefined` 与 `[]` 区分开——前者是"这份提取早于该字段"，后者是"提取了但没有模块"。
   */
  readonly method_modules?: readonly MethodModule[]
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
  'method_modules',
  'innovations',
  'future_work',
  'limitations',
  'benchmarks',
  'metrics',
  'baseline_methods',
  'extraction_quality',
] as const
