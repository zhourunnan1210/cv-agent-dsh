/**
 * `ideaScore` 服务（P3-3b）：把 core 的确定性打分算法接到真实知识库上。
 *
 * 服务平面归属（勘误 §4.4.1 裁定）：**preset + 与 `kb` 相同的 isolate realm**——
 * 它"没有自己的状态，状态就是 kb"，必须与 kb 同 realm 才能读到同一个库实例。
 * 组合文件里本行与 `cv-agent-dsh/kb` 必须同处一个 group。
 *
 * 职责边界（§11.2 分工表）：
 * - **本服务只做确定性的事**：读 pack 配置 → 四库检索 → 相似度估计 → 证据派生 →
 *   应用裁判判定 → 加权聚合 → 产出可复算报告；
 * - **LLM 的事在 dsh 侧工具层**：生成与判定都由子代理完成，本服务不调 LLM。
 *
 * pack 来源：`<packDir>/<pack_id>-<version>.json`（冻结产物）优先，缺省回落到
 * `…draft.json`。**未冻结时必须如实标记**（`pack_frozen: false`）——否则下游会
 * 把"草案权重"当成"人工评审过的口径"。
 *
 * @module cv-agent-dsh/idea-score
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import {
  applyJudgment,
  classifyBand,
  classifyRisk,
  deriveEvidence,
  lexicalSimilarity,
  totalScore,
  type CollisionEvidence,
  type DeriveEvidenceInput,
  type HitInput,
  type IdeaCandidate,
  type JudgeInput,
  type ScoringConfig,
  type ScoringDimensions,
  type ScoringReport,
} from '@cv-research/core'

import type { KbService } from '../kb/service.js'
import type { KbEntry } from '@cv-research/core'

/** 插件配置。 */
export interface Config {
  /** 冻结 pack 所在目录。 */
  packDir?: string
  packId?: string
  version?: string
  /** 每次检索每库取多少条候选（进证据包的上限）。 */
  topk?: number
  /** 边界带：相似度落在此区间 → 建议外扩外部检索。缺省用 pack 的 keyword_only 配置。 */
  boundaryBand?: readonly [number, number]
}

export const Config = Schema.object({
  packDir: Schema.string().default('data/packs').description('Domain Pack 目录。'),
  packId: Schema.string().default('deepfake-detection'),
  version: Schema.string().default('0.1'),
  topk: Schema.number().default(10),
})

/** 解析配置默认值（E19：不带 config 的行，默认值必须显式落定）。 */
export function resolveIdeaScoreConfig(config: Config | undefined): Required<Omit<Config, 'boundaryBand'>> & { boundaryBand?: readonly [number, number] } {
  return {
    packDir: config?.packDir ?? 'data/packs',
    packId: config?.packId ?? 'deepfake-detection',
    version: config?.version ?? '0.1',
    topk: config?.topk ?? 10,
    ...(config?.boundaryBand === undefined ? {} : { boundaryBand: config.boundaryBand }),
  }
}

/** 把服务挂到 Context 上（与 `kb` 同款做法；工具行按名注入）。 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    ideaScore: IdeaScoreService
  }
}

/** pack 装载结果。 */
export interface PackLoad {
  readonly config: ScoringConfig
  readonly pack_id: string
  readonly version: string
  readonly frozen: boolean
  readonly frozen_by: string | null
  readonly path: string
}

/** 某条候选证据的来源（进上下文的最小形态）。 */
export interface RetrievedEvidence {
  readonly hits: readonly HitInput[]
  readonly failure_hits: readonly HitInput[]
  readonly retrieval_mode: 'keyword_only' | 'vector'
}

export class IdeaScoreService extends Service {
  static inject = ['kb']

  private readonly options: ReturnType<typeof resolveIdeaScoreConfig>
  private pack: PackLoad | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'ideaScore')
    this.options = resolveIdeaScoreConfig(config)
  }

  /** 装载 pack（冻结产物优先，回落到草案；两者都缺则报错——没有权重的打分没有意义）。 */
  async loadPack(): Promise<PackLoad> {
    if (this.pack !== undefined) return this.pack
    const frozenPath = resolve(this.options.packDir, `${this.options.packId}-${this.options.version}.json`)
    const draftPath = resolve(this.options.packDir, `${this.options.packId}-${this.options.version}.draft.json`)
    for (const [path, frozen] of [[frozenPath, true], [draftPath, false]] as const) {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as {
          ref?: { pack_id?: string; version?: string }
          frozen_by?: string
          scoring?: ScoringConfig
        }
        if (parsed.scoring === undefined) continue
        this.pack = {
          config: parsed.scoring,
          pack_id: parsed.ref?.pack_id ?? this.options.packId,
          version: parsed.ref?.version ?? this.options.version,
          frozen,
          frozen_by: parsed.frozen_by ?? null,
          path,
        }
        return this.pack
      } catch {
        // 尝试下一个候选路径
      }
    }
    throw new Error(
      `找不到 Domain Pack：${frozenPath} 或 ${draftPath}。`
      + '打分必须有权威权重——先跑 scripts/bootstrap-pack.mjs（草案）或 freeze-pack.mjs（冻结）。',
    )
  }

  /** 当前使用的打分配置 + 冻结状态（工具层必须把它写进报告）。 */
  async packInfo(): Promise<{ pack_id: string; version: string; frozen: boolean; frozen_by: string | null; retrieval_mode: 'keyword_only' | 'vector' }> {
    const pack = await this.loadPack()
    return {
      pack_id: pack.pack_id,
      version: pack.version,
      frozen: pack.frozen,
      frozen_by: pack.frozen_by,
      // embedding 未接入前一律 keyword_only（§9.3 结论）——如实标记，不假装是向量检索
      retrieval_mode: 'keyword_only',
    }
  }

  /**
   * 确定性召回：三个库 + 失败库各取 topk 条候选，映射为证据行。
   *
   * 注意哪一侧用什么查询串：
   * - problems 侧用 `idea.problem`；methods 侧用 `idea.method`；
   * - innovations 与 failures 侧用「problem + method」的组合串（它们最接近"这件事做过了吗"）。
   */
  async retrieve(idea: Pick<IdeaCandidate, 'problem' | 'method' | 'statement'>): Promise<RetrievedEvidence> {
    const pack = await this.loadPack()
    const topk = this.options.topk
    const kb = this.ctx.kb as KbService
    const comboQuery = `${idea.problem} ${idea.method}`.trim()

    const toHits = (entries: readonly KbEntry[], query: string): HitInput[] => entries.map((entry) => ({
      ref_id: entry.entry_id,
      source: entry.store,
      statement: entry.statement,
      // backend_score 不传：让 core 用自带的有界相似度估计（FTS5 rank 不可比，§11.5）
      backend_score: lexicalSimilarity(query, entry.statement),
      external: false,
    }))

    const problemHits = toHits(kb.searchEntries({ store: 'problems', query: idea.problem, limit: topk }), idea.problem)
    const methodHits = toHits(kb.searchEntries({ store: 'methods', query: idea.method, limit: topk }), idea.method)
    const comboHits = toHits(kb.searchEntries({ store: 'innovations', query: comboQuery, limit: topk }), comboQuery)
    const failureHits = toHits(kb.searchEntries({ store: 'failures', query: comboQuery, limit: topk }), comboQuery)
    // pack 里可能有更严的边界带（keyword_only 实测校准值），服务配置可覆盖
    void pack
    return { hits: [...problemHits, ...methodHits, ...comboHits], failure_hits: failureHits, retrieval_mode: 'keyword_only' }
  }

  /** 证据派生（确定性）：基线分 + 是否建议外扩外部检索。 */
  async derive(idea: Pick<IdeaCandidate, 'problem' | 'method'>, evidence: RetrievedEvidence) {
    const pack = await this.loadPack()
    const band = this.options.boundaryBand ?? pack.config.thresholds.keyword_only?.boundary_band
    const input: DeriveEvidenceInput = {
      problem: idea.problem,
      method: idea.method,
      problemHits: evidence.hits.filter((hit) => hit.source === 'problems'),
      methodHits: evidence.hits.filter((hit) => hit.source === 'methods'),
      comboHits: [
        ...evidence.hits.filter((hit) => hit.source === 'innovations'),
        ...evidence.failure_hits,
      ],
      retrievalMode: evidence.retrieval_mode,
      ...(band === undefined ? {} : { boundaryBand: band }),
    }
    return deriveEvidence(input)
  }

  /**
   * 聚合为打分报告（确定性）：裁判判定 + 证据 → 四维分 → 总分/档位/风险/失败库复查。
   *
   * `pack_frozen: false` 时报告里带 `rationale` 前缀告警——草案权重不算权威口径。
   */
  async aggregate(options: {
    idea: IdeaCandidate
    derived: ReturnType<typeof deriveEvidence>
    judge: JudgeInput
    evidence: RetrievedEvidence
    escalatedExternal?: boolean
  }): Promise<ScoringReport & { pack_frozen: boolean; pack_ref: string; weight_sum: number }> {
    const pack = await this.loadPack()
    const judged = applyJudgment(options.derived, options.judge)
    const dimensions = judged.dimensions
    const total = totalScore(dimensions, pack.config)
    const suggestion = classifyBand(total, pack.config)
    const risk = classifyRisk(judged.evidence, pack.config, options.evidence.retrieval_mode)

    // 失败库复查：命中不直接丢弃——blocked_by 与 waivers 都来自裁判的逐条判定
    const failureRefs = new Set(options.evidence.failure_hits.map((hit) => hit.ref_id))
    const failureEvidence = judged.evidence.filter((item) => failureRefs.has(item.ref_id))
    const failureReview = {
      hit_refs: [...failureRefs],
      blocked_by: failureEvidence.filter((item) => item.verdict === 'collision').map((item) => item.ref_id),
      waivers: failureEvidence
        .filter((item) => item.verdict === 'superficial')
        .map((item) => ({ ref_id: item.ref_id, reason: item.reason })),
    }

    const similarPapers = judged.evidence
      .filter((item) => item.source === 'papers' || item.verdict === 'collision')
      .slice(0, 10)
      .map((item) => ({ paper_id: item.ref_id, reason: item.reason === '' ? item.statement_excerpt.slice(0, 120) : item.reason, score: item.similarity }))

    const warning = pack.frozen ? '' : `[未冻结 pack：${pack.path} 为草案，权重尚未获人工评审] `
    const weightSum = Object.values(pack.config.dimensions).reduce((sum, value) => sum + value, 0)
    return {
      idea_id: options.idea.idea_id,
      total,
      dimensions,
      dimension_trace: judged.trace,
      evidence: judged.evidence,
      weights_snapshot: pack.config.dimensions,
      risk_level: risk,
      similar_papers: similarPapers,
      suggestion,
      rationale: `${warning}${options.judge.rationale ?? ''}`.trim(),
      retrieval_mode: options.evidence.retrieval_mode,
      escalated_external: options.escalatedExternal ?? false,
      failure_review: failureReview,
      ...(options.judge.judged_by === undefined ? {} : { judged_by: options.judge.judged_by }),
      ...(options.judge.judged_at === undefined ? {} : { judged_at: options.judge.judged_at }),
      pack_frozen: pack.frozen,
      pack_ref: `${pack.pack_id}@${pack.version}`,
      weight_sum: weightSum,
    }
  }

  /** 组装裁判上下文（工具层把它交给裁判子代理；**不在本层调用 LLM**）。 */
  buildJudgePayload(options: {
    idea: Pick<IdeaCandidate, 'statement' | 'problem' | 'method' | 'innovation'>
    derived: ReturnType<typeof deriveEvidence>
    evidence: RetrievedEvidence
    external?: readonly { ref_id: string; statement: string; similarity?: number }[]
  }): string {
    const lines: string[] = []
    lines.push('[候选 idea]')
    lines.push(`陈述：${options.idea.statement}`)
    lines.push(`问题侧：${options.idea.problem}`)
    lines.push(`方法侧：${options.idea.method}`)
    lines.push(`预期创新：${options.idea.innovation}`)
    lines.push('')
    lines.push(`[本地证据 top-${options.evidence.hits.length + options.evidence.failure_hits.length}]（source, 相似度）：`)
    for (const item of options.derived.evidence) {
      lines.push(`- ${item.ref_id} (${item.source}, sim=${item.similarity.toFixed(3)}) ${item.statement_excerpt}`)
    }
    if (options.external !== undefined && options.external.length > 0) {
      lines.push('')
      lines.push(`[外扩检索证据 ${options.external.length} 条]（external=true）：`)
      for (const item of options.external) {
        lines.push(`- ${item.ref_id} (external, sim=${(item.similarity ?? 0).toFixed(3)}) ${item.statement.slice(0, 160)}`)
      }
    }
    lines.push('')
    lines.push('任务：对**每一条**证据判定 collision（实质撞车/失败条件仍成立）或 superficial（只是表面相似/条件已变），并给出理由。')
    lines.push('不要给总分，也不要给出四维分值——分数由系统从你的逐条判定算出。')
    return lines.join('\n')
  }

  /** 复算校验（工具层/审计用）：报告是否自洽。 */
  verify(report: ScoringReport): { consistent: boolean; recomputed: number } {
    const weights = report.weights_snapshot ?? { novelty_problem: 30, novelty_method: 30, novelty_combo: 25, feasibility: 15 }
    const recomputed = Math.round(
      (report.dimensions.novelty_problem * weights.novelty_problem
        + report.dimensions.novelty_method * weights.novelty_method
        + report.dimensions.novelty_combo * weights.novelty_combo
        + report.dimensions.feasibility * weights.feasibility)
      / (weights.novelty_problem + weights.novelty_method + weights.novelty_combo + weights.feasibility),
    )
    return { consistent: recomputed === report.total, recomputed }
  }
}

/** 默认导出：loader 取 `module.default`（E18-②）。 */
export default IdeaScoreService

/** 供测试与工具层复用的类型再导出。 */
export type { CollisionEvidence, ScoringDimensions }
