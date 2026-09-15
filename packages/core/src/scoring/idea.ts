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

/** 候选 Idea（v1.2 §10）。 */
export interface IdeaCandidate {
  readonly idea_id: string
  /** 一句话描述。 */
  readonly statement: string
  /** 问题侧描述，用于向量检索问题库。 */
  readonly problem: string
  /** 方法侧描述，用于向量检索方法库。 */
  readonly method: string
  /** 预期创新点。 */
  readonly innovation: string
  /** 建议的 1–3 篇 baseline 论文 ID。 */
  readonly baselines: readonly string[]
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
 * 打分报告（v1.2 §6.2 / §10）。
 *
 * 注意：`degraded` 字段是相对 v1.2 §10 接口的**新增项**。v1.2 §19 要求
 * 「向量嵌入服务不可用 → 撞车分析标记 `degraded: keyword_only`」，
 * 但 §10 的 `ScoringReport` 没有承载该标记的字段。此处补上，
 * 否则降级状态会在报告层丢失。
 */
export interface ScoringReport {
  readonly idea_id: string
  /** 总分 0–100。 */
  readonly total: number
  readonly dimensions: ScoringDimensions
  readonly risk_level: CollisionRisk
  readonly similar_papers: readonly SimilarPaper[]
  readonly suggestion: IdeaSuggestion
  readonly rationale: string
  /** 撞车分析所依据的检索模式；非 `vector` 时结论可信度下降。 */
  readonly retrieval_mode: 'vector' | 'keyword_only'
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

/** 打分维度权重配置，来自 Domain Pack 的 `scoring.yml`（v1.2 §18.4）。 */
export interface ScoringConfig {
  readonly dimensions: ScoringDimensions
  readonly thresholds: {
    /** 组合判定的相似度阈值。 */
    readonly high_risk_similarity: number
    readonly topk: number
  }
  readonly suggestion_bands: {
    readonly proceed: readonly [number, number]
    readonly revise: readonly [number, number]
    readonly abandon: readonly [number, number]
  }
}
