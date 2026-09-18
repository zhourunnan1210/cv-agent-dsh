/**
 * Idea 决策层的类型契约（平台无关）。
 *
 * 设计依据：v1.2 文档 §6、§10、§18.4。
 *
 * 算法本身（向量检索 + 组合判定 + 四维加权）在 Phase 3 实现；
 * 本文件先冻结**输入输出契约**，因为它是工具面（§15.4）与材料包（§8.1）
 * 共同依赖的部分，改动代价最高。
 */

import type { KnowledgeBase } from '../schema/kb.js'
import type { MethodModule, MethodModuleKind } from '../schema/extraction.js'
import type { Disagreement, ExpertAggregation, ExpertRole, ExpertVerdict } from '../experts.js'

/**
 * Idea 的一个组成模块——**与论文侧 `MethodModule` 同构**。
 *
 * 同构是刻意的：撞车就是拿 idea 的模块逐条去比库里的模块，两边的字段含义必须一致，
 * 否则"对齐"无从谈起（整合设计 v1.0 §2 的核心原则：四层共用一套结构）。
 * 差异只有一处：idea 侧多一个 `expected_advantage`——它要说明"这个模块凭什么更好"，
 * 而论文侧不需要（论文已经有实验结果了）。
 */
export interface IdeaModule extends MethodModule {
  /** 预期优势：这个模块凭什么比现有做法好。 */
  readonly expected_advantage: string
}

/** Idea 的一条创新点（比 `innovation` 汇总串更结构化，便于逐条比对与归档）。 */
export interface IdeaInnovation {
  readonly statement: string
  readonly kind: 'new_method' | 'new_framework' | 'new_loss' | 'new_dataset' | 'new_benchmark' | 'new_insight' | 'other'
  /** 对应哪个模块（模块名）。 */
  readonly related_module?: string
}

export type { MethodModuleKind }

/** 候选 Idea（v1.2 §10）。 */
export interface IdeaCandidate {  readonly idea_id: string
  /** 一句话标题（整合设计 v1.0：与库侧论文标题同粒度，便于人工扫读）。 */
  readonly title?: string
  /** 一句话描述。 */
  readonly statement: string
  /** 问题侧描述，用于向量检索问题库。 */
  readonly problem: string
  /** 方法侧描述，用于向量检索方法库。 */
  readonly method: string
  /**
   * 方法组成模块（整合设计 v1.0 新增）——**与论文侧的 `method_modules` 同构**。
   *
   * 撞车的对齐单元就是它：逐模块问"库里有没有人做过这个模块"。
   * 没有它，撞车只能退回"整体像不像"（而那个判据已实测不可信）。
   */
  readonly method_modules?: readonly IdeaModule[]
  /** 预期创新点。 */
  readonly innovation: string
  /** 逐条创新点（结构化版；与 `innovation` 并存，后者是给人读的汇总）。 */
  readonly innovations?: readonly IdeaInnovation[]
  /**
   * 预期评测设定（整合设计 v1.0 新增）。
   *
   * 独立成结构而不是写进自由文本：评测专家要判断"这个设定库里有没有被覆盖过"，
   * 需要能按基准/指标/协议逐项比对。
   */
  readonly evaluation?: {
    readonly benchmarks: readonly string[]
    readonly metrics: readonly string[]
    readonly protocols: readonly string[]
    readonly baselines: readonly string[]
  }
  /** 预期提升（尽量给可量化表述）。 */
  readonly expected_gain?: string
  /** 这条 idea 最可能怎么失败（2–4 条）。 */
  readonly risks?: readonly string[]
  /** 建议的 1–3 篇 baseline 论文 ID。 */
  readonly baselines: readonly string[]
  /**
   * 产出该候选的**视角**（P3-3：N 个 Generator 各持一个视角并行生成）。
   *
   * 记录视角是为了审计与去重：合并后仍要知道「这条 idea 是从哪个角度想出来的」，
   * 以及「哪些视角根本没产出」（空视角本身是信息：可能该方向已被做透）。
   */
  readonly lens?: string
  /** 产出该候选的 Generator 标识（委派 id 或角色名），供审计。 */
  readonly generated_by?: string
  /**
   * 人工授权标记。
   *
   * **为什么需要这个字段**（勘误 E15）：委派给子代理时，其审批策略被 dsh
   * 硬性钉为 `'never'`——子代理**不能**在运行中途发起审批请求，只能做父代理
   * 已被授权做的事。因此一切需要人类授权的动作（启动云 GPU 实例、调用计费 API、
   * 破坏性文件操作）都必须在**委派之前**由主 Agent 取得授权，并把结果作为
   * 数据下发。
   *
   * 这里记录的就是那份授权：主 Agent 取得用户同意后写入，子代理只读。
   * 未授权时子代理**不得**执行对应动作，只能回报
   * `status: 'needs_authorization'`（见 `NeedsAuthorization`）请求主 Agent 补授权。
   */
  readonly authorization?: Authorization
}

/**
 * 一次委派的人工授权记录。
 *
 * 设计依据：勘误 §5.2 / E15。
 */
export interface Authorization {
  /** 授权范围：本次委派允许执行的动作。 */
  readonly granted: readonly AuthorizedAction[]
  /** 授权人标识（用户会话或用户本人）。 */
  readonly granted_by: string
  /** ISO 8601 时间戳。 */
  readonly granted_at: string
  /**
   * 成本上限（如 GPU 小时、ai4scholar 积分）。
   *
   * 与 v1.2 §20 的预算护栏对应：C 模式超限需自动降级为 B（勘误 §4.3），
   * 降级后的重新授权同样经由此字段下发。
   */
  readonly budget?: Readonly<Record<string, number>>
}

/**
 * 需要人类授权才能继续的动作类别。
 *
 * 对应 v1.2 §4.2 的「C 模式安全边界」三条，加上实验执行层的具体动作。
 */
export type AuthorizedAction =
  /** 启动云 GPU 实例（云厂商 API / SSH 拉起）。 */
  | 'launch_gpu_instance'
  /** 调用计费 API（ai4scholar credits）。 */
  | 'call_billed_api'
  /** 破坏性文件系统操作。 */
  | 'destructive_fs_operation'
  /** 超出既定预算上限。 */
  | 'exceed_budget'

/**
 * 子代理回报「需要授权」时的结构化载荷。
 *
 * 这是 E15 约束下的**唯一合法出路**：子代理无法自行发起审批，因此它把这个
 * 载荷作为 `outputSchema` 的结构化结果返回给主 Agent，由主 Agent 走
 * §4.3 的三段式门控向用户取得授权，再决定是否重新委派。
 *
 * @example
 * ```ts
 * const reply: NeedsAuthorization = {
 *   status: 'needs_authorization',
 *   action: 'launch_gpu_instance',
 *   reason: '跨数据集评估需要在 4090 上跑 6 小时，当前无授权',
 *   estimated_cost: { gpu_hours: 6 },
 * }
 * ```
 */
export interface NeedsAuthorization {
  readonly status: 'needs_authorization'
  readonly action: AuthorizedAction
  /** 自然语言说明为何需要该授权。 */
  readonly reason: string
  /** 预估成本，供主 Agent 向用户呈现。 */
  readonly estimated_cost?: Readonly<Record<string, number>>
}

/**
 * 判断子代理返回的结构化结果是否为「需要授权」。
 *
 * 主 Agent 在收到子代理结果后应先过这个判断，再决定是继续还是走门控。
 */
export function isNeedsAuthorization(value: unknown): value is NeedsAuthorization {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { status?: unknown; action?: unknown; reason?: unknown }
  return candidate.status === 'needs_authorization' && typeof candidate.action === 'string' && typeof candidate.reason === 'string'
}

/** 撞车风险级别（v1.2 §6.2 组合判定）。 */
export type CollisionRisk = 'high' | 'medium' | 'low'

/**
 * 打分维度。
 *
 * 权重**不在代码里**：来自 Domain Pack 的 `scoring.yml`
 * （Deepfake 包默认 30/30/25/15，见 v1.2 §18.4）。因此这里只固定维度名，
 * 保证跨领域可复用（原则六）。
 */
export interface ScoringDimensions {
  /** 问题新颖度：问题库中是否存在高度相似问题。 */
  readonly novelty_problem: number
  /** 方法新颖度：方法库中是否存在高度相似方法。 */
  readonly novelty_method: number
  /** 组合新颖度：问题-方法组合是否已出现（撞车分析结果）。 */
  readonly novelty_combo: number
  /** 可行性：基于建议 baseline 的实验设计可行性。 */
  readonly feasibility: number
}

/** 建议档位（v1.2 §6.2 输出）。 */
export type IdeaSuggestion = 'proceed' | 'revise' | 'abandon'

/** 相似论文及其相似理由。 */
export interface SimilarPaper {
  readonly paper_id: string
  readonly doi?: string
  /** 自然语言说明为何相似（LLM 复核产出，v1.2 §6.2 第 5 步）。 */
  readonly reason: string
  readonly score?: number
}

/**
 * 一条撞车证据（P3-3：**裁判必须证据锚定**）。
 *
 * 设计动机：如果让 LLM 直接吐一个"新颖度 78 分"，分数既不可复现也无法审计
 * （同一 idea 两次打分不同，pack 里的阈值与权重全部失去意义）。因此拆成：
 * 检索给出候选与相似度 → 裁判对**每一条候选**给出判定与理由 → 数值由 core 算。
 */
export interface CollisionEvidence {
  /** 撞到的条目/论文 ID（三库条目用 entry_id，论文用 paper_id）。 */
  readonly ref_id: string
  /** 命中来源：哪个库，或论文库。`failures` 是第四库（失败方法库，P3-3c 加入）。 */
  readonly source: 'problems' | 'methods' | 'innovations' | 'failures' | 'papers'
  /** 检索侧的陈述片段（供人复核"它到底是不是同一件事"）。 */
  readonly statement_excerpt: string
  /** 确定性的相似度估计（∈[0,1]，语义由 `retrieval_mode` 决定，见 §11.5）。 */
  readonly similarity: number
  /** 是否来自外扩的外部检索（Asta），而非本地库。 */
  readonly external: boolean
  /** 裁判判定：是否构成实质撞车。 */
  readonly verdict: 'collision' | 'superficial' | 'unjudged'
  /** 裁判给出的理由（自然语言，LLM 产出；`unjudged` 时为空串）。 */
  readonly reason: string
}

/**
 * 维度取值 = 检索证据 + 裁判判定 → 确定性函数算出的分数。
 *
 * `retrieval_baseline` 与 `final` 分开记录，是为了让"裁判调整了多少"可见：
 * 裁判可以提升风险（检索漏掉的语义撞车）或降低风险（检索命中的其实只是表面相似），
 * 但两者都留痕，且 `final` 由 core 从证据重算得出，不是裁判直接报的数。
 */
export interface DimensionScore {
  readonly retrieval_baseline: number
  readonly final: number
  /** 裁判是否调整过该维度（未调整时 final === retrieval_baseline）。 */
  readonly adjusted_by_judge: boolean
}

/**
 * 打分报告（v1.2 §6.2 / §10）。
 *
 * 注意：`degraded` 字段是相对 v1.2 §10 接口的**新增项**。v1.2 §19 要求
 * 「向量嵌入服务不可用 → 撞车分析标记 `degraded: keyword_only`」，
 * 但 §10 的 `ScoringReport` 没有承载该标记的字段。此处补上，
 * 否则降级状态会在报告层丢失。
 *
 * P3-3 追加**自包含**要求：报告必须携带复算所需的一切（逐维证据、裁判判定与理由、
 * 外扩检索是否发生、检索模式、权重快照），使分数可逐位重算、可审计。
 */
export interface ScoringReport {
  readonly idea_id: string
  /** 总分 0–100。 */
  readonly total: number
  readonly dimensions: ScoringDimensions
  /** 逐维度的「检索基线 → 最终值」轨迹（P3-3 新增）。 */
  readonly dimension_trace?: Readonly<Record<keyof ScoringDimensions, DimensionScore>>
  /** 撞车证据清单（P3-3 新增）：裁判逐条判定的依据。 */
  readonly evidence?: readonly CollisionEvidence[]
  /** 本次打分使用的权重快照（来自冻结 pack，P3-3 新增；便于事后复算）。 */
  readonly weights_snapshot?: ScoringDimensions
  readonly risk_level: CollisionRisk
  readonly similar_papers: readonly SimilarPaper[]
  readonly suggestion: IdeaSuggestion
  readonly rationale: string
  /** 撞车分析所依据的检索模式；非 `vector` 时结论可信度下降。 */
  readonly retrieval_mode: 'vector' | 'keyword_only'
  /** 是否触发了外部（Asta）外扩检索（P3-3 新增）。 */
  readonly escalated_external?: boolean
  /**
   * 失败方法库复查结果（P3-3c 新增，勘误 §12.2）。
   *
   * 语义：命中失败库**不直接丢弃** idea——`blocked_by` 非空表示"失败条件仍然成立"，
   * `waivers` 记录"为什么这次不一样"（由裁判给出，必须写理由）。
   */
  readonly failure_review?: {
    /** 检出的相关失败条目 ID。 */
    readonly hit_refs: readonly string[]
    /** 判定为"条件仍成立"的失败条目（这些才是真正阻塞的）。 */
    readonly blocked_by: readonly string[]
    /** 判定为"条件已变、值得再试"的失败条目及理由。 */
    readonly waivers: readonly { readonly ref_id: string; readonly reason: string }[]
  }
  /** 裁判标识与时间（P3-3 新增，审计用）。 */
  readonly judged_by?: string
  readonly judged_at?: string
  /**
   * 三专家面板的审计载荷（整合设计 v1.0 §6.6）。
   *
   * 旧链路只有一个裁判——报告里只有"算出来的分数"。面板链路下，报告必须能回答
   * "三位专家各说了什么、哪里分歧、讨论后有没有收敛"，否则聚合出的中位数不可审计。
   *
   * 可选：`judged_by`/`judge` 单裁判链路仍可用（旧报告不缺字段）。
   */
  readonly panel?: PanelAudit
}

/**
 * 三专家面板的审计载荷（整合设计 v1.0 §6.6）。
 *
 * `experts` 是**参与最终聚合**的那一轮判定（讨论后即第二轮），`initial` 保留首轮，
 * 使"讨论改变了什么"可以被复核，而不是只能相信结论。
 */
export interface PanelAudit {
  readonly experts: readonly ExpertVerdict[]
  /** 首轮判定（审计：看得出讨论前后差异）。 */
  readonly initial?: readonly ExpertVerdict[]
  /** 首轮检测到的分歧。 */
  readonly disagreements: readonly Disagreement[]
  /** 讨论后仍在的分歧（非空表示 panel 是"带分歧收敛"的）。 */
  readonly remaining: readonly Disagreement[]
  readonly discussed: boolean
  /** 每位专家各自给的分数（审计：看得出中位数从哪几个数来）。 */
  readonly per_dimension?: ExpertAggregation['per_dimension']
  /** 失败或被丢弃的专家——少于 3 位时聚合照跑，但报告要如实说。 */
  readonly failed: readonly { readonly expert: ExpertRole; readonly error: string }[]
  /** 判定与分数矛盾之处（面板自洽性检查）。 */
  readonly conflicts: readonly string[]
  /** 给了分却没有 `evidence_refs` 的模块判定。 */
  readonly unsupported: readonly string[]
  /** idea 模块级对齐结论（跨专家多数票），工具层直接汇报这个。 */
  readonly module_alignment: readonly {
    readonly idea_module: string
    readonly status: 'new' | 'partial' | 'known'
    /** 少数派意见（有的话）——多数票不等于无异议。 */
    readonly dissent: readonly { readonly expert: ExpertRole; readonly status: string; readonly reason: string }[]
  }[]
}

/**
 * Idea 打分器接口（v1.2 §10）。
 *
 * LLM 调用走依赖注入，使本层保持平台无关（v1.2 §3.3 表格：
 * 「Idea 打分：打分算法、相似度计算、评分维度」属 core，
 * 「LLM 调用、工具注册」属 dsh-plugin）。
 */
export interface IdeaScorer {
  score(idea: IdeaCandidate, kb: KnowledgeBase): Promise<ScoringReport>
}

/**
 * 相似度阈值。
 *
 * ⚠️ **阈值必须按检索模式区分**（P3-3 实测，勘误 §11.5）：`high_risk_similarity`
 * 是给 embedding 余弦定的口径（同义不同词也能到 0.85+）；字符 trigram Jaccard 的
 * 尺度完全不同——用真实语料标定（`scripts/calibrate-similarity2.mjs`，69 对
 * 「同内容但被改写过」的正例 vs 69 对无关论文）：
 *
 * | 阈值 | 正例召回 | 负例误报 |
 * | --- | --- | --- |
 * | ≥0.10 | 62% | 1/69 |
 * | ≥0.15 | 30% | 0/69 |
 * | ≥0.30 | 10% | 0/69（此档基本是"同文"） |
 *
 * 因此 keyword_only 模式另给一套：**相关候选 0.10 / 近似同文 0.30 / 边界带 [0.10, 0.30)**。
 * 把余弦口径的 0.85 直接套到 keyword 模式上，会**严重漏判撞车**（实测负例最大才 0.135）。
 */
export interface ScoringThresholds {
  /** 组合判定的相似度阈值（**vector 模式**口径）。 */
  readonly high_risk_similarity: number
  readonly topk: number
  /** keyword_only（字符 trigram）模式的角色与阈值；缺省时回落到 `high_risk_similarity`。 */
  readonly keyword_only?: {
    /** 相关候选阈值（召回优先）：用于「可能撞车，交给裁判」的召回门。 */
    readonly related_similarity: number
    /** 近似同文阈值（高精度）：此档以上可直接判撞，不必等裁判。 */
    readonly near_duplicate_similarity: number
    /** 边界带：落在其中说明检索判据不足 → 触发外部（Asta）外扩检索。 */
    readonly boundary_band: readonly [number, number]
  }
}

/** 打分维度权重配置，来自 Domain Pack 的 `scoring.yml`（v1.2 §18.4）。 */
export interface ScoringConfig {
  readonly dimensions: ScoringDimensions
  readonly thresholds: ScoringThresholds
  readonly suggestion_bands: {
    readonly proceed: readonly [number, number]
    readonly revise: readonly [number, number]
    readonly abandon: readonly [number, number]
  }
}
