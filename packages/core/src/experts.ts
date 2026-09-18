/**
 * 三专家打分：判定结构 + 分歧检测 + 确定性聚合（整合设计 v1.0 §6）。
 *
 * ## 与旧机制的区别
 *
 * 旧机制：**一个**裁判只给逐条判定（collision / superficial），**分数由 core 从相似度算**
 * （`novelty = 100 × (1 − 相似度)`）——这就是那个"写得越详细越显得新颖"的病根。
 *
 * 新机制：
 * - **三位专家**（方法/评测/领域）各自判**模块级对齐**（new / partial / known）**并给四维分**；
 * - 分歧（任一维度分差 > 15，或同一模块判定不同）→ 组织**一轮讨论**，各自修正一次；
 * - 本层做**确定性聚合**：中位数 → 加权总分 → 档位，外加**一致性校验**。
 *
 * ## 为什么分数要"从模块判定来"而不是拍脑袋
 *
 * 报告里的每个数字都要能指回来源。模块判定带 `evidence_refs`（引用了哪条模块/条目/论文），
 * 分数从判定聚合而来 → 数字可追溯。专家若判某模块 `known` 却在对应维度给高分，
 * §6.5 的校验会点名这个矛盾——**但不改写分数**（旧机制"撞车封顶 20"就是系统篡改专家判断）。
 *
 * @module @cv-research/core/scoring-experts
 */

import type { ScoringDimensions } from './scoring/idea.js'

/** 位专家身份（分工互补，非同质评委）。 */
export type ExpertRole = 'method' | 'evaluation' | 'domain'

/** 一位专家对一个 idea 模块的对齐判定。 */
export interface ModuleVerdict {
  /** idea 的模块名（与 idea.method_modules 里的名字对应）。 */
  readonly idea_module: string
  readonly status: 'new' | 'partial' | 'known'
  /**
   * 支撑该判定的引用：模块 ID / 条目 ID / 论文 ID。
   *
   * 给分必须有依据——§6.5 会把"给了分却没有引用"的情况标成 unsupported。
   */
  readonly evidence_refs: readonly string[]
  readonly reason: string
}

/** 一位专家的完整判定。 */
export interface ExpertVerdict {
  readonly expert: ExpertRole
  readonly module_verdicts: readonly ModuleVerdict[]
  /** 该专家给的四维分（0–100）。 */
  readonly dimension_scores: ScoringDimensions
  readonly rationale: string
  /** 第几轮（首轮 1；讨论后修正为 2）。 */
  readonly round?: number
}

/** 分歧点。 */
export interface Disagreement {
  /** `dimension:novelty_method` 或 `module:频域一致性约束`。 */
  readonly target: string
  readonly kind: 'dimension' | 'module'
  readonly positions: readonly { expert: ExpertRole; value: string; reason: string }[]
}

/** 聚合结果。 */
export interface ExpertAggregation {
  /** 中位数聚合后的四维分。 */
  readonly dimensions: ScoringDimensions
  /** 加权总分（四舍五入）。 */
  readonly total: number
  /** 档位。 */
  readonly band: 'proceed' | 'revise' | 'abandon'
  /** 每位专家各自的四维中位数（审计：看得出聚合前后差异）。 */
  readonly per_dimension: Readonly<Record<keyof ScoringDimensions, readonly number[]>>
  readonly disagreement: 'none' | 'resolved_by_discussion' | 'high'
  /** 判定与分数矛盾之处（点名专家/模块/维度）。 */
  readonly conflicts: readonly string[]
  /** 给了分却没有 evidence_refs 的模块判定。 */
  readonly unsupported: readonly string[]
}

/** 维度键（顺序即权重快照里的顺序）。 */
export const DIMENSION_KEYS = ['novelty_problem', 'novelty_method', 'novelty_combo', 'feasibility'] as const

/** 中位数（偶数个取中间两个的均值；不改动传入数组）。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * 检测分歧（§6.3 的触发条件）。
 *
 * 两个来源：
 * 1. **维度分差 > 阈值**（同一位专家之间的口径差异）；
 * 2. **同一模块判定不同**（"这是新的" vs "库里已有" —— 这种分歧比分数分歧更值得讨论）。
 *
 * @param verdicts - 各位专家的判定（同一轮）。
 * @param dimensionThreshold - 维度分差阈值（默认 15，设计 §10 开放项 3）。
 * @returns 分歧清单；空数组表示无需讨论。
 */
export function detectDisagreements(
  verdicts: readonly ExpertVerdict[],
  dimensionThreshold = 15,
): Disagreement[] {
  if (verdicts.length < 2) return []
  const disagreements: Disagreement[] = []

  for (const dimension of DIMENSION_KEYS) {
    const scored = verdicts.map((verdict) => ({ expert: verdict.expert, score: verdict.dimension_scores[dimension] }))
    const high = Math.max(...scored.map((item) => item.score))
    const low = Math.min(...scored.map((item) => item.score))
    if (high - low > dimensionThreshold) {
      disagreements.push({
        target: `dimension:${dimension}`,
        kind: 'dimension',
        positions: verdicts.map((verdict) => ({
          expert: verdict.expert,
          value: String(verdict.dimension_scores[dimension]),
          reason: verdict.rationale.slice(0, 200),
        })),
      })
    }
  }

  // 模块判定分歧：按模块名归组，看各家 status 是否一致
  const byModule = new Map<string, { expert: ExpertRole; status: string; reason: string }[]>()
  for (const verdict of verdicts) {
    for (const moduleVerdict of verdict.module_verdicts) {
      const list = byModule.get(moduleVerdict.idea_module) ?? []
      list.push({ expert: verdict.expert, status: moduleVerdict.status, reason: moduleVerdict.reason.slice(0, 200) })
      byModule.set(moduleVerdict.idea_module, list)
    }
  }
  for (const [moduleName, positions] of byModule) {
    if (positions.length < 2) continue
    if (new Set(positions.map((position) => position.status)).size > 1) {
      disagreements.push({
        target: `module:${moduleName}`,
        kind: 'module',
        positions: positions.map((position) => ({
          expert: position.expert,
          value: position.status,
          reason: position.reason,
        })),
      })
    }
  }
  return disagreements
}

/**
 * 聚合三份专家判定 → 最终分数（**确定性、可复算**）。
 *
 * 规则（设计 §6.4 / §6.5）：
 * - 每个维度取**中位数**（不用均值——抗离群：一个跑偏的专家不该把结论拖走）；
 * - 总分 = `Σ(维度 × 权重)`，权重来自冻结 pack（`weights_snapshot`）；
 * - 档位按 pack 的 `suggestion_bands`；
 * - **一致性校验**：判 `known` 却给高分（> `conflictScoreCeiling`）→ 记 `conflicts`，
 *   但**分数不改**（系统不篡改专家判断）；给了分却没有引用 → 记 `unsupported`；
 * - 分歧标记：聚合后仍分歧 → `high`；讨论轮后收敛 → `resolved_by_discussion`。
 *
 * @param verdicts - 用于聚合的那一轮判定（讨论后传入第二轮）。
 * @param weights - 四维权重（合计 100）。
 * @param bands - 档位区间。
 * @param options - 可选：剩余分歧、是否经过讨论、冲突分数上限。
 * @returns 聚合结果。
 */
export function aggregateExperts(
  verdicts: readonly ExpertVerdict[],
  weights: ScoringDimensions,
  bands: { proceed: readonly [number, number]; revise: readonly [number, number]; abandon: readonly [number, number] },
  options: { remainingDisagreements?: readonly Disagreement[]; discussed?: boolean; conflictScoreCeiling?: number } = {},
): ExpertAggregation {
  if (verdicts.length === 0) throw new Error('aggregateExperts：至少要有一位专家的判定')
  const ceiling = options.conflictScoreCeiling ?? 40

  const perDimension = Object.fromEntries(
    DIMENSION_KEYS.map((dimension) => [dimension, verdicts.map((verdict) => verdict.dimension_scores[dimension])]),
  ) as Record<(typeof DIMENSION_KEYS)[number], number[]>

  const dimensions: ScoringDimensions = {
    novelty_problem: Math.round(median(perDimension.novelty_problem)),
    novelty_method: Math.round(median(perDimension.novelty_method)),
    novelty_combo: Math.round(median(perDimension.novelty_combo)),
    feasibility: Math.round(median(perDimension.feasibility)),
  }

  const total = Math.round(
    dimensions.novelty_problem * weights.novelty_problem
    + dimensions.novelty_method * weights.novelty_method
    + dimensions.novelty_combo * weights.novelty_combo
    + dimensions.feasibility * weights.feasibility,
  ) / 100
  const rounded = Math.round(total)

  const band: ExpertAggregation['band'] = rounded >= bands.proceed[0]
    ? 'proceed'
    : (rounded >= bands.revise[0] ? 'revise' : 'abandon')

  // ── 一致性校验：判定与分数矛盾（点名到专家 / 模块 / 维度）──────────────
  const conflicts: string[] = []
  const unsupported: string[] = []
  for (const verdict of verdicts) {
    for (const moduleVerdict of verdict.module_verdicts) {
      if (moduleVerdict.evidence_refs.length === 0) {
        unsupported.push(`${verdict.expert} 对模块「${moduleVerdict.idea_module}」给了判定但没有任何引用`)
      }
      // "说它已有、却给高新颖度"是最典型的自相矛盾
      if (moduleVerdict.status === 'known' && verdict.dimension_scores.novelty_method > ceiling) {
        conflicts.push(
          `${verdict.expert} 判模块「${moduleVerdict.idea_module}」= known，`
          + `却在 novelty_method 给 ${verdict.dimension_scores.novelty_method}（> ${ceiling}）`,
        )
      }
    }
  }

  const remaining = options.remainingDisagreements ?? []
  const disagreement: ExpertAggregation['disagreement'] = remaining.length > 0
    ? 'high'
    : (options.discussed === true ? 'resolved_by_discussion' : 'none')

  return { dimensions, total: rounded, band, per_dimension: perDimension, disagreement, conflicts, unsupported }
}

/**
 * idea 模块级对齐结论：跨专家**多数票** + 少数派留痕。
 *
 * 为什么不取"最严"或"最松"：三位专家分工不同（方法/评测/领域），对同一模块给出不同
 * 判定是**正常**的（"这个机制是新的，但它服务的问题已被解决"）。多数票给出主结论，
 * `dissent` 保留异议——否则报告会把"两位说新、一位说旧"粉饰成"一致认为是新的"。
 *
 * 平票（三专家各执一词，或两两相同无法过半）按**更保守**的一方取（known > partial > new）：
 * 撞车检测里乐观的代价比保守高。
 *
 * @param verdicts - 参与最终聚合的那一轮判定。
 * @returns 每个 idea 模块一条，顺序按首次出现。
 */
export function moduleAlignment(verdicts: readonly ExpertVerdict[]): {
  idea_module: string
  status: 'new' | 'partial' | 'known'
  dissent: { expert: ExpertRole; status: string; reason: string }[]
}[] {
  const order: string[] = []
  const byModule = new Map<string, { expert: ExpertRole; status: 'new' | 'partial' | 'known'; reason: string }[]>()

  for (const verdict of verdicts) {
    for (const moduleVerdict of verdict.module_verdicts) {
      if (!byModule.has(moduleVerdict.idea_module)) {
        byModule.set(moduleVerdict.idea_module, [])
        order.push(moduleVerdict.idea_module)
      }
      // 同一位专家重复判同一模块时只认第一条：重复不构成多数
      const positions = byModule.get(moduleVerdict.idea_module)!
      if (positions.some((position) => position.expert === verdict.expert)) continue
      positions.push({ expert: verdict.expert, status: moduleVerdict.status, reason: moduleVerdict.reason })
    }
  }

  // 保守序：已知 > 部分 > 新
  const severity: Record<'new' | 'partial' | 'known', number> = { new: 0, partial: 1, known: 2 }

  return order.map((ideaModule) => {
    const positions = byModule.get(ideaModule) ?? []
    const counts = new Map<'new' | 'partial' | 'known', number>()
    for (const position of positions) counts.set(position.status, (counts.get(position.status) ?? 0) + 1)
    let status: 'new' | 'partial' | 'known' = 'new'
    let best = -1
    for (const [candidateStatus, count] of counts) {
      const better = count > best
        || (count === best && severity[candidateStatus] > severity[status])
      if (better) {
        status = candidateStatus
        best = count
      }
    }
    const dissent = positions
      .filter((position) => position.status !== status)
      .map((position) => ({ expert: position.expert, status: position.status as string, reason: position.reason }))
    return { idea_module: ideaModule, status, dissent }
  })
}

/** 把分歧清单渲染成讨论轮的 prompt 片段（三位专家互见理由）。 */
export function renderDiscussionPrompt(disagreements: readonly Disagreement[]): string {
  if (disagreements.length === 0) return ''
  const lines: string[] = ['[需要你们讨论的分歧点]', '下面是彼此不一致的地方，附上各自的理由。请各自判断：维持还是修正？并说明为什么。', '']
  for (const disagreement of disagreements) {
    lines.push(disagreement.kind === 'dimension'
      ? `◆ 维度分歧：${disagreement.target.replace('dimension:', '')}`
      : `◆ 模块判定分歧：「${disagreement.target.replace('module:', '')}」`)
    for (const position of disagreement.positions) {
      lines.push(`   - ${position.expert}：${position.value}`)
      lines.push(`     理由：${position.reason}`)
    }
    lines.push('')
  }
  lines.push('要求：对每个分歧点给出「维持」或「修正」+ 理由；修正后重新给出你的四维分。')
  return lines.join('\n')
}
