/**
 * Idea 打分的**确定性部分**（平台无关纯函数，P3-3）。
 *
 * 设计依据：勘误 §11（2026-09-17 需求细化）的三条硬规则——
 * ① 生成者 ≠ 裁判；② 裁判只做证据锚定的判定、**数值由本文件算**；
 * ③ 报告自包含、可复算。
 *
 * 本文件不调 LLM、不碰数据库、不依赖 dsh：LLM 调用在 dsh 侧的工具层
 * （委派裁判子代理），本层只负责「证据 → 分数」的确定性映射。
 *
 * ## 为什么自带相似度估计（§11.5）
 *
 * 现有检索给不出 [0,1] 相似度：FTS5 `rank` 是无界负值（bm25 变体），`LIKE`
 * 回退没有分数。而冻结 pack 里的 `high_risk_similarity`、边界带、三档映射都要求
 * 可比数值。因此本层自带 `lexicalSimilarity`（字符 trigram Jaccard），在
 * `keyword_only` 模式下使用；embedding 到位后换成余弦，**契约与阈值都不变**。
 */

import type { CollisionEvidence, DimensionScore, ScoringDimensions } from './idea.js'
import type { ScoringConfig } from './idea.js'

/** 检索模式（与 `RetrievalMode` 同义，避免跨文件耦合）。 */
export type ScoreRetrievalMode = 'vector' | 'keyword_only'

/**
 * 字符级 trigram 集合（含 1/2-gram 短串兜底），用于 Jaccard 相似度。
 *
 * 为什么用字符而不用词：中文没有空格分词，字符 n-gram 对中英混排都稳定；
 * 归一化（小写、去非字母数字、压缩空白）与三库 statement 的去重归一化同源，
 * 保证「同一句话的两种写法」在这里也高度相似。
 */
export function trigramSet(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const grams = new Set<string>()
  if (normalized === '') return grams
  const compact = normalized.replace(/\s+/g, '')
  if (compact.length <= 3) {
    grams.add(compact)
    return grams
  }
  for (let i = 0; i <= compact.length - 3; i += 1) grams.add(compact.slice(i, i + 3))
  return grams
}

/**
 * 词项集合（按非字母数字切分），用于补一层"词级"信号。
 *
 * trigram 对**同义改写**（deepfake → face forgery）无能为力，这一层也不解决语义，
 * 但它能把「方法名相同但句式不同」这类情况拉高一点，减少假阴性。
 */
export function termSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1),
  )
}

/**
 * 确定性相似度 ∈ [0,1]：字符 trigram Jaccard 与词 Jaccard 的加权融合。
 *
 * ⚠️ **词层是自适应的，不能固定 0.6/0.4**：中文没有空格分词，按非字母数字切分
 * 会把整句变成一个 token（「跨数据集泛化与持续学习遗忘」→ 1 个 token），此时词层
 * Jaccard 恒为 0，会把语序不同但用词相同的两句从 0.57 压到 0.34（实测）。
 * 因此：某一侧词数 < 2 时自动**退化为纯 trigram**；两侧都有足够词项（英文/术语场景）
 * 才启用词层。
 */
export function lexicalSimilarity(a: string, b: string): number {
  if (a.trim() === '' || b.trim() === '') return 0
  const gramScore = jaccard(trigramSet(a), trigramSet(b))
  const termA = termSet(a)
  const termB = termSet(b)
  if (termA.size < 2 || termB.size < 2) return round4(gramScore)
  return round4(0.6 * gramScore + 0.4 * jaccard(termA, termB))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 检索命中的最小形态（由调用方从 kb 检索结果映射而来）。 */
export interface HitInput {
  readonly ref_id: string
  readonly source: CollisionEvidence['source']
  readonly statement: string
  /** 检索后端给的分数（可选；缺省时用本层的 lexicalSimilarity 估计）。 */
  readonly backend_score?: number
  /** 是否来自外扩的外部检索。 */
  readonly external?: boolean
}

/** 裁判对单条证据的判定（LLM 产出，由调用方注入）。 */
export interface JudgeVerdict {
  readonly ref_id: string
  readonly verdict: 'collision' | 'superficial'
  readonly reason: string
}

/** 裁判对四个维度的补充判定（LLM 产出）。 */
export interface JudgeInput {
  /** 逐条证据判定；未列出的证据保持 `unjudged`。 */
  readonly verdicts: readonly JudgeVerdict[]
  /** 裁判给出的可行性分（0–100）；缺省时用确定性的中位默认值。 */
  readonly feasibility?: number
  /** 总分理由。 */
  readonly rationale?: string
  readonly judged_by?: string
  readonly judged_at?: string
}

/** `deriveEvidence` 的输入。 */
export interface DeriveEvidenceInput {
  readonly problem: string
  readonly method: string
  readonly problemHits: readonly HitInput[]
  readonly methodHits: readonly HitInput[]
  /** 与问题侧/方法侧共同命中的论文（组合新颖度用）：共现的 paper_id → 陈述片段。 */
  readonly comboHits?: readonly HitInput[]
  readonly retrievalMode: ScoreRetrievalMode
  readonly boundaryBand?: readonly [number, number]
}

/** 证据派生结果（确定性）。 */
export interface DerivedEvidence {
  readonly evidence: readonly CollisionEvidence[]
  /** 各维度的检索基线分（0–100，未含裁判调整）。 */
  readonly baselines: ScoringDimensions
  /** 是否落在边界带内（→ 建议外扩外部检索）。 */
  readonly needs_external: boolean
  /** 触发外扩的原因说明（供报告与日志）。 */
  readonly external_reason: string
}

/**
 * 从检索命中派生证据与检索基线分（确定性，不含 LLM）。
 *
 * 基线分定义（0–100，越高越新颖）：
 * - `novelty_problem` = 100 × (1 − max(问题侧相似度))
 * - `novelty_method`  = 100 × (1 − max(方法侧相似度))
 * - `novelty_combo`   = 100 × (1 − max(组合共现相似度))；无共现证据时给保守值 70
 *   （无证据 ≠ 新颖，不能给满分，否则"没人做过"会变成默认结论）
 * - `feasibility`     = 由裁判给；检索阶段只给中位默认值 60
 */
export function deriveEvidence(input: DeriveEvidenceInput): DerivedEvidence {
  // 边界带：keyword_only 用实测校准的 [0.10, 0.30)；vector 用 [0.70, 0.90)（余弦尺度）
  const band = input.boundaryBand
    ?? (input.retrievalMode === 'vector' ? [0.7, 0.9] as const : [0.1, 0.3] as const)
  const evidence: CollisionEvidence[] = []

  // 问题侧与方法侧各自用自己的查询串估计相似度：调用方若已给 backend_score 则直接用
  const problemMax = maxSimilarity(input.problem, input.problemHits)
  const methodMax = maxSimilarity(input.method, input.methodHits)
  const comboQuery = input.method === '' ? input.problem : input.method
  const comboHits = input.comboHits ?? []
  const comboMax = maxSimilarity(comboQuery, comboHits)
  for (const hit of input.problemHits) evidence.push(toEvidence(hit, input.problem))
  for (const hit of input.methodHits) evidence.push(toEvidence(hit, input.method))
  for (const hit of comboHits) evidence.push(toEvidence(hit, comboQuery))

  const baselines: ScoringDimensions = {
    novelty_problem: toScore(problemMax),
    novelty_method: toScore(methodMax),
    // 无共现证据时给保守值 70：**无证据 ≠ 新颖**，给满分会让"没人做过"变成默认结论
    novelty_combo: comboHits.length === 0 ? 70 : toScore(comboMax),
    feasibility: 60,
  }

  // 边界带：任一侧相似度落在 [lo, hi) 区间 → 检索结论不够确定，建议外扩
  const nearThreshold = [problemMax, methodMax, comboMax].filter((value) => value >= band[0] && value < band[1])
  const needsExternal = nearThreshold.length > 0
  return {
    evidence,
    baselines,
    needs_external: needsExternal,
    external_reason: needsExternal
      ? `相似度 ${nearThreshold.map((value) => value.toFixed(2)).join('/')} 落在边界带 [${band[0]}, ${band[1]})，本地库判据不充分`
      : '',
  }
}

function maxSimilarity(query: string, hits: readonly HitInput[]): number {
  let max = 0
  for (const hit of hits) {
    const similarity = hit.backend_score ?? lexicalSimilarity(query, hit.statement)
    if (similarity > max) max = similarity
  }
  return round4(Math.min(Math.max(max, 0), 1))
}

function toEvidence(hit: HitInput, query: string): CollisionEvidence {
  const raw = hit.backend_score ?? lexicalSimilarity(query, hit.statement)
  return {
    ref_id: hit.ref_id,
    source: hit.source,
    statement_excerpt: hit.statement.slice(0, 160),
    similarity: round4(Math.min(Math.max(raw, 0), 1)),
    external: hit.external ?? false,
    verdict: 'unjudged',
    reason: '',
  }
}

function toScore(similarity: number): number {
  return Math.round(100 * (1 - similarity))
}

/**
 * 应用裁判判定 → 得到最终维度分（**分值仍由本层算**）。
 *
 * 规则：
 * - 某维度若存在被裁判判为 `collision` 的证据 → 该维度按「最相似的撞车证据」重算，
 *   且**封顶 20 分**（撞车即新颖度极低，不允许裁判把分数抬回去）；
 * - 判为 `superficial` 的证据 → 从该维度的相似度里剔除（裁判解释了它只是表面相似）；
 * - `feasibility` 直接采用裁判给出的值（缺省保留基线）；非法值（<0 或 >100）回落到基线。
 *
 * 这样"裁判能改变结论、但不能凭空报数"：它只能通过判定与理由影响**证据集合**，
 * 分数始终是证据的函数。
 */
export function applyJudgment(
  derived: DerivedEvidence,
  judge: JudgeInput,
): { evidence: CollisionEvidence[]; dimensions: ScoringDimensions; trace: Record<keyof ScoringDimensions, DimensionScore> } {
  const verdictByRef = new Map(judge.verdicts.map((verdict) => [verdict.ref_id, verdict]))
  const evidence: CollisionEvidence[] = derived.evidence.map((item) => {
    const verdict = verdictByRef.get(item.ref_id)
    return verdict === undefined
      ? item
      : { ...item, verdict: verdict.verdict, reason: verdict.reason }
  })

  const scoreDimension = (source: CollisionEvidence['source'], baseline: number): DimensionScore => {
    const relevant = evidence.filter((item) => item.source === source)
    const collisions = relevant.filter((item) => item.verdict === 'collision')
    if (collisions.length > 0) {
      const worst = Math.max(...collisions.map((item) => item.similarity))
      return { retrieval_baseline: baseline, final: Math.min(toScore(worst), 20), adjusted_by_judge: true }
    }
    const remaining = relevant.filter((item) => item.verdict !== 'superficial')
    if (remaining.length === 0 && relevant.length > 0) {
      // 裁判把全部命中都判为表面相似 → 该维度按"无相似"结论处理（谨慎给 85，不给 100）
      return { retrieval_baseline: baseline, final: 85, adjusted_by_judge: true }
    }
    return { retrieval_baseline: baseline, final: baseline, adjusted_by_judge: false }
  }

  const problems = scoreDimension('problems', derived.baselines.novelty_problem)
  const methods = scoreDimension('methods', derived.baselines.novelty_method)
  const comboEvidence = evidence.filter((item) => item.source === 'papers' || item.source === 'innovations')
  const comboBaseline = derived.baselines.novelty_combo
  const comboTrace: DimensionScore = comboEvidence.some((item) => item.verdict === 'collision')
    ? {
        retrieval_baseline: comboBaseline,
        final: Math.min(toScore(Math.max(...comboEvidence.filter((item) => item.verdict === 'collision').map((item) => item.similarity))), 20),
        adjusted_by_judge: true,
      }
    : { retrieval_baseline: comboBaseline, final: comboBaseline, adjusted_by_judge: false }

  const feasibilityValue = judge.feasibility
  const feasibility: DimensionScore = feasibilityValue !== undefined && feasibilityValue >= 0 && feasibilityValue <= 100
    ? { retrieval_baseline: derived.baselines.feasibility, final: Math.round(feasibilityValue), adjusted_by_judge: true }
    : { retrieval_baseline: derived.baselines.feasibility, final: derived.baselines.feasibility, adjusted_by_judge: false }

  return {
    evidence,
    dimensions: {
      novelty_problem: problems.final,
      novelty_method: methods.final,
      novelty_combo: comboTrace.final,
      feasibility: feasibility.final,
    },
    trace: {
      novelty_problem: problems,
      novelty_method: methods,
      novelty_combo: comboTrace,
      feasibility,
    },
  }
}

/** 加权总分（确定性）：Σ(权重 × 维度分) / 100，四舍五入到整数。 */
export function totalScore(dimensions: ScoringDimensions, config: ScoringConfig): number {
  const weights = config.dimensions
  const weightSum = weights.novelty_problem + weights.novelty_method + weights.novelty_combo + weights.feasibility
  const weighted = dimensions.novelty_problem * weights.novelty_problem
    + dimensions.novelty_method * weights.novelty_method
    + dimensions.novelty_combo * weights.novelty_combo
    + dimensions.feasibility * weights.feasibility
  return Math.round(weighted / weightSum)
}

/** 档位映射（确定性）：由 pack 的 `suggestion_bands` 决定。 */
export function classifyBand(total: number, config: ScoringConfig): 'proceed' | 'revise' | 'abandon' {
  const bands = config.suggestion_bands
  if (total >= bands.proceed[0] && total <= bands.proceed[1]) return 'proceed'
  if (total >= bands.abandon[0] && total <= bands.abandon[1]) return 'abandon'
  return 'revise'
}

/**
 * 撞车风险级（确定性，按模式取阈值）。
 *
 * 判据顺序（P3-3 校准后的口径）：
 * 1. **近似同文**（相似度 ≥ 该模式的 near-dup 阈值）→ high，不必等裁判；
 * 2. 裁判判定的实质撞车 **≥2 条** → high；恰 1 条 → medium；
 * 3. 其余 → low（裁判判为表面相似的命中不计入）。
 *
 * vector 模式的 near-dup 阈值就是 pack 的 `high_risk_similarity`（余弦口径）；
 * keyword_only 模式用它自己的 `near_duplicate_similarity`（实测 0.30 档零误报）。
 */
export function classifyRisk(
  evidence: readonly CollisionEvidence[],
  config: ScoringConfig,
  mode: ScoreRetrievalMode = 'keyword_only',
): 'high' | 'medium' | 'low' {
  const nearDuplicate = mode === 'vector'
    ? config.thresholds.high_risk_similarity
    : (config.thresholds.keyword_only?.near_duplicate_similarity ?? config.thresholds.high_risk_similarity)
  const considered = evidence.filter((item) => item.verdict !== 'superficial')
  if (considered.length === 0) return 'low'
  if (considered.some((item) => item.similarity >= nearDuplicate)) return 'high'
  const collisions = considered.filter((item) => item.verdict === 'collision')
  if (collisions.length >= 2) return 'high'
  if (collisions.length === 1) return 'medium'
  return 'low'
}

/**
 * 复算校验：从报告自带的字段重算总分，验证与 `report.total` 一致。
 *
 * 这是「报告自包含、可复算」这条硬规则的**可执行判据**：审计时不需要重跑 LLM
 * 或重查数据库，只需报告本身。
 */
export function recomputeTotal(report: {
  readonly dimensions: ScoringDimensions
  readonly weights_snapshot?: ScoringDimensions
}): number {
  const weights = report.weights_snapshot ?? {
    novelty_problem: 30,
    novelty_method: 30,
    novelty_combo: 25,
    feasibility: 15,
  }
  return totalScore(report.dimensions, {
    dimensions: weights,
    thresholds: { high_risk_similarity: 0.85, topk: 10 },
    suggestion_bands: { proceed: [75, 100], revise: [50, 74], abandon: [0, 49] },
  })
}
