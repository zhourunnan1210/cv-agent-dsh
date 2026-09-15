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
