/**
 * 三专家打分面板（整合设计 v1.0 §6）：委派、分歧检测、一轮讨论、确定性聚合。
 *
 * ## 为什么是三个专家而不是一个裁判
 *
 * 旧机制：**一个**裁判只给逐条 collision/superficial 判定，**分数由 core 从字符相似度算**
 * （`novelty = 100 × (1 − 相似度)`）。三个后果（都有实测）：
 * 1. 同义改写的相似度是 0.0039 → 真撞车被判成满分新颖；
 * 2. 一个 LLM 判定有随机性，没有交叉验证；
 * 3. 分数不是"推理出来的"，是"算出来的"——报告里说不出"为什么是 72 分"。
 *
 * 新机制：三位**分工互补**的专家各自判**模块级对齐**并给四维分 → 分歧触发一轮讨论
 * → 中位数聚合。分数来自推理，且每个数字能指回模块与证据。
 *
 * ## 三位专家的分工（非同质评委）
 *
 * | 专家 | 盯什么 |
 * | --- | --- |
 * | `method` 方法/架构 | 模块、机制、损失与库中已有做法的实质差异 |
 * | `evaluation` 实验/评测 | 基准、指标、跨域设定库里有没有覆盖过 |
 * | `domain` 领域/问题 | 同一问题簇内是否已有工作在同类条件下成立 |
 *
 * 三者独立委派、互不可见对方材料（§11.8 约束 4：生成者 ≠ 裁判）。
 *
 * @module cv-agent-dsh/scoring-panel
 */

import type { ExpertRole, ExpertVerdict, Disagreement, ExpertAggregation, ScoringDimensions } from '@cv-research/core'
import { aggregateExperts, detectDisagreements, renderDiscussionPrompt } from '@cv-research/core'

import type { SubagentLike } from '../subagent.js'
import { SUBAGENT_MAX_DEPTH } from '../subagent.js'

/** 三位专家的身份与关注点（渲染进 prompt）。 */
export const EXPERT_PERSONAS: Record<ExpertRole, string> = {
  method: [
    '你是**方法/架构专家**，评审一条研究 idea 的方法设计。',
    '你只关心一件事：这条 idea 的每个模块，与库里已有做法的**实质差异**在哪里。',
    '特别注意：模块名不同不等于机制不同（"频域一致性约束"与"频率一致性损失"很可能是同一件事）；',
    '反之名字相同也可能用法不同。请结合证据里论文的方法描述判断，不要只看名字。',
    '对 idea 的每个模块给出 new（库里没有）/ partial（类似但有关键差异）/ known（库里已有）三级判定，并引用依据。',
    '然后给四维分。分数是你**推理出来的**，不是算出来的——但必须与你的模块判定自洽。',
  ].join(' '),
  evaluation: [
    '你是**实验/评测专家**，评审一条研究 idea 的评测设计。',
    '你只关心一件事：这条 idea 打算用的基准、指标、评测协议，库里是否已经被覆盖过。',
    '特别注意：如果同一问题簇里已经有人在同一基准、同一协议下做过，那么"再报一遍同样的数字"没有信息量——',
    '要在 novelty_combo 上如实扣分。反之如果它提出了库里没见过的跨域设定或新指标组合，那是真实贡献。',
    '对 idea 的每个模块给出 new/partial/known 判定（从"这个模块是否已被实验验证过"的角度），并引用依据。',
    '然后给四维分。分数必须与你的判定自洽。',
  ].join(' '),
  domain: [
    '你是**领域/问题专家**，评审一条研究 idea 要解决的问题。',
    '你只关心一件事：这个问题在库里是否已经被解决过——尤其是在**同类条件下**（同一模态、同一伪造类型、同一评测设定）。',
    '特别注意：失败方法库里的条目不是"不许做"，而是"当时在那个条件下不成立"；',
    '如果条件变了（新数据集、新主干、更强算力），那不算撞车，请在理由里说清"条件怎么变了"。',
    '对 idea 的每个模块给出 new/partial/known 判定（从"它服务的问题是否已被解决"的角度），并引用依据。',
    '然后给四维分。分数必须与你的判定自洽。',
  ].join(' '),
}

/**
 * 专家的工具面：**只给 `read`**（继承旧裁判的隔离红线，§11.8 约束 1）。
 *
 * 理想情况下专家不需要任何工具（证据全在 prompt 里）。给 `read` 是允许"受限追问"：
 * 专家若认为某条证据片段不足以判断，可以读随包给它的文件。
 * **不给检索工具**——否则专家会自行扩大证据集合，把"输入由确定性检索决定"这条底线破掉。
 * 三位专家共用同一份工具面：分工靠 persona，不靠工具。
 */
export const EXPERT_TOOL_FILTER = { allow: ['read'] } as const

/** 四维分的取值域（schema 与本地校验共用一份）。 */
const SCORE_FIELDS = ['novelty_problem', 'novelty_method', 'novelty_combo', 'feasibility'] as const

/** 专家判定的 outputSchema（三位共用——结构一致才谈得上聚合）。 */
export function expertOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      module_verdicts: {
        type: 'array',
        description: '对 idea 每个模块的对齐判定（一个模块一条，不要漏）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            idea_module: { type: 'string', description: 'idea 的模块名（与给你的名字一致）' },
            status: { type: 'string', enum: ['new', 'partial', 'known'] },
            evidence_refs: {
              type: 'array',
              items: { type: 'string' },
              description: '支撑该判定的引用：模块 ID（MODxxx）/ 条目 ID（P/M/I/Fxxx）/ 论文 ID。给判定必须有依据。',
            },
            reason: { type: 'string', description: '理由：差在哪 / 像在哪 / 条件是否变了' },
          },
          required: ['idea_module', 'status', 'evidence_refs', 'reason'],
        },
      },
      dimension_scores: {
        type: 'object',
        additionalProperties: false,
        description: '四维分（0–100，整数）。分数由你的推理给出，但必须与模块判定自洽。',
        properties: Object.fromEntries(
          SCORE_FIELDS.map((field) => [field, { type: 'integer', description: `${field}（0–100）` }]),
        ),
        required: [...SCORE_FIELDS],
      },
      rationale: { type: 'string', description: '一段话：你的总体判断与关键理由' },
    },
    required: ['module_verdicts', 'dimension_scores', 'rationale'],
  }
}

/** 宽松校验：形状不对的判定被丢弃而不是让整轮崩（一位专家答歪不该毁掉整条链路）。 */
export function coerceExpertVerdict(role: ExpertRole, value: unknown, round: number): ExpertVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>

  const moduleVerdicts: ExpertVerdict['module_verdicts'][number][] = []
  if (Array.isArray(raw.module_verdicts)) {
    for (const item of raw.module_verdicts) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const ideaModule = typeof entry.idea_module === 'string' ? entry.idea_module.trim() : ''
      const status = entry.status === 'new' || entry.status === 'partial' || entry.status === 'known' ? entry.status : undefined
      if (ideaModule === '' || status === undefined) continue
      moduleVerdicts.push({
        idea_module: ideaModule,
        status,
        evidence_refs: Array.isArray(entry.evidence_refs) ? entry.evidence_refs.map(String) : [],
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      })
    }
  }

  const scoresRaw = (typeof raw.dimension_scores === 'object' && raw.dimension_scores !== null
    ? raw.dimension_scores
    : {}) as Record<string, unknown>
  const clamp = (input: unknown): number => {
    const value = Number(input)
    if (!Number.isFinite(value)) return 50   // 缺分给中性值，而不是 0 或 100（两者都会歪曲中位数）
    return Math.min(100, Math.max(0, Math.round(value)))
  }
  const dimension_scores: ScoringDimensions = {
    novelty_problem: clamp(scoresRaw.novelty_problem),
    novelty_method: clamp(scoresRaw.novelty_method),
    novelty_combo: clamp(scoresRaw.novelty_combo),
    feasibility: clamp(scoresRaw.feasibility),
  }

  return {
    expert: role,
    module_verdicts: moduleVerdicts,
    dimension_scores,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    round,
  }
}

/** 面板运行结果。 */
export interface PanelResult {
  /** 用于最终聚合的那一轮（讨论后是第二轮）。 */
  readonly final: readonly ExpertVerdict[]
  /** 首轮（审计：看得出讨论前后差异）。 */
  readonly initial: readonly ExpertVerdict[]
  readonly disagreements: readonly Disagreement[]
  /** 讨论后仍存在的分歧。 */
  readonly remaining: readonly Disagreement[]
  readonly discussed: boolean
  readonly aggregation: ExpertAggregation
  /** 失败或被丢弃的专家（diagnostic 用；少于 3 位时聚合照跑，但报告要如实说）。 */
  readonly failed: readonly { expert: ExpertRole; error: string }[]
}

/** `runExpertPanel` 的入参。 */
export interface PanelOptions {
  readonly ideaId: string
  /** 专家上下文（`renderCollisionContext` 的输出）。 */
  readonly context: string
  readonly weights: ScoringDimensions
  readonly bands: { proceed: readonly [number, number]; revise: readonly [number, number]; abandon: readonly [number, number] }
  readonly agent: unknown
  readonly signal: AbortSignal
  /** 维度分差阈值（默认 15，设计 §10 开放项 3）。 */
  readonly discussionThreshold?: number
}

/**
 * 跑一次三专家面板：**并行**委派 → 分歧检测 → **一轮**讨论 → 聚合。
 *
 * 并行而不是串行：三位专家互不可见对方材料，没有依赖，串行只是白等三倍时间。
 *
 * @param subagents - 委派服务。
 * @param options - 上下文、权重、档位、阈值。
 * @returns 面板结果（含两轮判定与聚合）。
 */
export async function runExpertPanel(subagents: SubagentLike, options: PanelOptions): Promise<PanelResult> {
  const roles: ExpertRole[] = ['method', 'evaluation', 'domain']
  const threshold = options.discussionThreshold ?? 15

  const ask = async (role: ExpertRole, prompt: string, round: number): Promise<ExpertVerdict | { error: string }> => {
    let run
    try {
      run = await subagents.start('spawn', {
        signal: options.signal,
        parent: options.agent,
        label: `expert:${role}${round > 1 ? `:r${round}` : ''}`,
        prompt: [{ type: 'text', text: prompt }],
        toolFilter: EXPERT_TOOL_FILTER,
        persona: EXPERT_PERSONAS[role],
        outputSchema: expertOutputSchema(),
        maxDepth: SUBAGENT_MAX_DEPTH,
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    try {
      const result = await run.result
      if (result.structured === undefined) {
        return { error: `未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）` }
      }
      const verdict = coerceExpertVerdict(role, result.structured, round)
      return verdict ?? { error: '返回的结构化结果形状非法' }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      await run.dispose()
    }
  }

  // ── 首轮：三位专家并行，互不可见对方材料 ─────────────────────────────
  const firstRound = await Promise.all(
    roles.map(async (role) => ({ role, outcome: await ask(role, options.context, 1) })),
  )
  const failed: { expert: ExpertRole; error: string }[] = []
  const initial: ExpertVerdict[] = []
  for (const { role, outcome } of firstRound) {
    if ('error' in outcome) failed.push({ expert: role, error: outcome.error })
    else initial.push(outcome)
  }
  if (initial.length === 0) {
    throw new Error(`三位专家全部失败，无法打分：${failed.map((item) => `${item.expert}(${item.error})`).join('；')}`)
  }

  // ── 分歧检测 → 一轮讨论（只跑一轮：成本可控，且第二轮必须出结论）──────
  const disagreements = detectDisagreements(initial, threshold)
  let final = initial
  let remaining: readonly Disagreement[] = []
  let discussed = false

  if (disagreements.length > 0 && initial.length > 1) {
    discussed = true
    const discussionPrompt = `${options.context}\n\n${renderDiscussionPrompt(disagreements)}`
    const secondRound = await Promise.all(
      initial.map(async (verdict) => ({ role: verdict.expert, outcome: await ask(verdict.expert, discussionPrompt, 2) })),
    )
    const revised: ExpertVerdict[] = []
    for (const { role, outcome } of secondRound) {
      if ('error' in outcome) {
        // 第二轮失败：**保留该专家首轮判定**，而不是把它踢出（否则中位数会被少数派重算）
        const first = initial.find((verdict) => verdict.expert === role)
        if (first !== undefined) revised.push(first)
        failed.push({ expert: role, error: `讨论轮失败，沿用首轮判定：${outcome.error}` })
      } else {
        revised.push(outcome)
      }
    }
    final = revised
    remaining = detectDisagreements(final, threshold)
  }

  const aggregation = aggregateExperts(final, options.weights, options.bands, {
    ...(remaining.length > 0 ? { remainingDisagreements: remaining } : {}),
    ...(discussed ? { discussed: true } : {}),
  })

  return { final, initial, disagreements, remaining, discussed, aggregation, failed }
}
