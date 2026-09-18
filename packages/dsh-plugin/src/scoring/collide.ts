/**
 * 撞车链路（整合设计 v1.0 §5）：三轴召回 → 证据卡 → 模块级对齐。
 *
 * ## 这一层替代了什么
 *
 * 旧机制：拿 idea 的整段文本去和**条目 statement** 算字符重合度，取最大值当"撞车程度"。
 * 三个致命问题（都有实测）：
 * 1. **语义上不可用**：同义改写 0.0039、同词乱序 1.0000；
 * 2. **长度归一化病态**：idea 写到 651 字时，即使把条目原文一字不差抄进去也只有 0.1785；
 * 3. **表达不了最常见的撞车形态**："3 个模块里有 2 个库里已有"——整体相似度说不出来。
 *
 * 本层的做法：
 * - **三轴并发召回**（问题簇 / 模块 / 做法），取并集 → 候选论文；
 * - **组装证据卡**：每篇候选论文一张（L2 全文 + L3 条目 + 命中的模块），**不截断**；
 * - **模块级对齐**：idea 的每个模块 → 库里候选模块 + 所属论文（确定性的候选，
 *   最终 new/partial/known 的判定由三位专家给，见 §6）。
 *
 * ## 本层是**确定性**的
 *
 * 只做检索与组装，不调 LLM、不算分数、不判"撞不撞"。判定属于专家（§11.3 的分工）。
 * 唯一用到的数值是各轴的排名——用于证据卡排序，不用作分数。
 *
 * @module cv-agent-dsh/scoring-collide
 */

import type { IdeaCandidate, KbEntry, MethodModule } from '@cv-research/core'

import type { KbService } from '../kb/service.js'
import type { ModuleRecord } from '../kb/modules.js'

/** 每轴取多少条候选（问题簇 / 模块 / 做法）。 */
const AXIS_TOPK = 10
/** 候选论文上限——证据卡是要进专家上下文的，不能无限。 */
const MAX_CANDIDATES = 12

/** 一个模块在库里找到的候选。 */
export interface ModuleHit {
  readonly idea_module: string
  readonly module_id: string
  readonly module_name: string
  /** 库里那条模块的陈述（截断到 200 字，完整版在证据卡里）。 */
  readonly statement: string
  /** 用了该模块的论文。 */
  readonly paper_ids: readonly string[]
  /** 该模块与 idea 模块的字符相似度——**仅用于排序**，不作为判据（§5.4）。 */
  readonly rank_score: number
}

/** 一篇候选论文的证据卡（进专家上下文的单位）。 */
export interface EvidenceCard {
  readonly paper_id: string
  readonly meta: { readonly title: string; readonly year?: number; readonly venue?: string }
  /** L2 提取全文，**不截断**——截断会让专家看不到结论（旧实现截 160 字）。 */
  readonly extraction?: {
    readonly problem_statement: string
    readonly method_summary: string
    readonly method_modules: readonly MethodModule[]
    readonly innovations: readonly string[]
    readonly limitations: readonly string[]
  }
  /** 该论文在四库里的条目（含"是否共享"）。 */
  readonly entries: readonly {
    readonly store: string
    readonly entry_id: string
    readonly statement: string
    readonly ext: Record<string, unknown>
    readonly shared_with: number
  }[]
  /** 该论文贡献的模块（撞车对齐时需要对照）。 */
  readonly modules: readonly { readonly module_id: string; readonly name: string }[]
  /** 它在三轴各自排第几（用于卡片排序；缺该轴则无此键）。 */
  readonly axis_ranks: { readonly problem?: number; readonly module?: number; readonly method?: number }
}

export interface CollisionReport {
  readonly idea_id: string
  readonly axes: {
    /** 问题轴：命中的跨论文问题簇及其论文集合。 */
    readonly problem_clusters: readonly { problem_entry_id: string; statement: string; papers: readonly string[] }[]
    /** 模块轴：idea 的每个模块在库里的候选。 */
    readonly module_hits: readonly ModuleHit[]
    /** 做法轴：命中的方法条目。 */
    readonly method_candidates: readonly { entry_id: string; statement: string; paper_ids: readonly string[] }[]
  }
  readonly candidates: readonly string[]
  readonly evidence_cards: readonly EvidenceCard[]
  /**
   * 给三位专家的"对齐任务"：idea 的每个模块 + 该模块在库里的全部候选。
   * 判定（new / partial / known）由专家给——本层只把材料摆齐。
   */
  readonly alignment_tasks: readonly { idea_module: ModuleModuleView; candidates: readonly ModuleHit[] }[]
  readonly computed_at: string
}

/** idea 模块在报告里的视图（专家看到的字段）。 */
export interface ModuleModuleView {
  readonly name: string
  readonly role: string
  readonly description: string
  readonly kind: string
  readonly expected_advantage?: string
}

/** 撞车链路只依赖 kb 的这几个读接口（便于测试替身）。 */
export interface CollideKbPort {
  searchEntries(options: { store: 'problems' | 'methods' | 'innovations' | 'failures'; query: string; limit: number }): KbEntry[]
  searchModules(options: { query?: string; paperId?: string; limit: number }): ModuleRecord[]
  papersSharingProblem(problemEntryId: string): string[]
  papersOfEntry(store: 'problems' | 'methods' | 'innovations' | 'failures', entryId: string): string[]
  papersOfModule(moduleId: string): string[]
  getPaperProfile(paperId: string): ReturnType<KbService['getPaperProfile']>
}

/** 依赖注入的相似度（默认是 core 的字符 trigram；embedding 到位后可换成余弦）。 */
export type RankSimilarity = (a: string, b: string) => number

/**
 * 跑一次撞车分析（**确定性**，不调 LLM）。
 *
 * @param idea - 结构化 idea（模块化是前提——没有模块就只能退回"整体像不像"）。
 * @param kb - 知识库读接口。
 * @param similarity - 排序用的相似度函数（仅排序，见 §5.4）。
 * @returns 撞车报告；`evidence_cards` 是给专家的材料，`alignment_tasks` 是对齐任务。
 */
export function collide(
  idea: IdeaCandidate,
  kb: CollideKbPort,
  similarity: RankSimilarity,
): CollisionReport {
  const rankOf = new Map<string, { problem?: number; module?: number; method?: number }>()
  const noteRank = (paperId: string, axis: 'problem' | 'module' | 'method', rank: number): void => {
    const current = rankOf.get(paperId) ?? {}
    if (current[axis] === undefined) rankOf.set(paperId, { ...current, [axis]: rank })
    else rankOf.set(paperId, current)
  }

  // ── 轴 1：问题簇（最有效的一轴——问题库天然成簇，一次能捞出一批论文）──────
  const problemClusters: { problem_entry_id: string; statement: string; papers: readonly string[] }[] = []
  const problemHits = kb.searchEntries({ store: 'problems', query: idea.problem, limit: AXIS_TOPK })
  problemHits.forEach((entry, index) => {
    const papers = kb.papersSharingProblem(entry.entry_id)
    if (papers.length === 0) return
    problemClusters.push({ problem_entry_id: entry.entry_id, statement: entry.statement, papers })
    for (const paperId of papers) noteRank(paperId, 'problem', index + 1)
  })

  // ── 轴 2：模块（★ 对齐单元；idea 的每个模块各查一次）────────────────────
  const moduleHits: ModuleHit[] = []
  const alignmentTasks: { idea_module: ModuleModuleView; candidates: ModuleHit[] }[] = []
  for (const module of idea.method_modules ?? []) {
    const view: ModuleModuleView = {
      name: module.name,
      role: module.role,
      description: module.description,
      kind: module.kind,
      ...('expected_advantage' in module && typeof module.expected_advantage === 'string'
        ? { expected_advantage: module.expected_advantage }
        : {}),
    }
    // 查询串用「名字 + 描述」：只用名字会漏掉"名字不同但做法相同"的（那正是要抓的）。
    const query = `${module.name} ${module.description}`.trim()
    const hits = kb.searchModules({ query, limit: AXIS_TOPK })
    const candidates: ModuleHit[] = hits.map((record, index) => {
      const paperIds = kb.papersOfModule(record.module_id)
      for (const paperId of paperIds) noteRank(paperId, 'module', index + 1)
      return {
        idea_module: module.name,
        module_id: record.module_id,
        module_name: record.name,
        statement: record.statement.slice(0, 200),
        paper_ids: paperIds,
        rank_score: similarity(query, `${record.name} ${record.statement}`),
      }
    })
    moduleHits.push(...candidates)
    alignmentTasks.push({ idea_module: view, candidates })
  }

  // ── 轴 3：做法（方法条目）────────────────────────────────────────────
  const methodEntries: { entry_id: string; statement: string; paper_ids: readonly string[] }[] = []
  const methodHits = kb.searchEntries({ store: 'methods', query: idea.method, limit: AXIS_TOPK })
  methodHits.forEach((entry, index) => {
    const paperIds = kb.papersOfEntry('methods', entry.entry_id)
    if (paperIds.length === 0) return
    methodEntries.push({ entry_id: entry.entry_id, statement: entry.statement, paper_ids: paperIds })
    for (const paperId of paperIds) noteRank(paperId, 'method', index + 1)
  })

  // ── 候选排序：按"被几轴命中、各轴排名之和"排（不用相似度——它已证明不可信）──
  const candidates = [...rankOf.entries()]
    .map(([paperId, ranks]) => {
      const axisCount = Object.keys(ranks).length
      const rankSum = Object.values(ranks).reduce((sum, rank) => sum + rank, 0)
      return { paperId, axisCount, rankSum, ranks }
    })
    .sort((left, right) => right.axisCount - left.axisCount || left.rankSum - right.rankSum || left.paperId.localeCompare(right.paperId))
    .slice(0, MAX_CANDIDATES)

  const evidenceCards: EvidenceCard[] = candidates.flatMap((candidate) => {
    const profile = kb.getPaperProfile(candidate.paperId)
    if (profile === undefined) return []
    const entries = (['problems', 'methods', 'innovations', 'failures'] as const).flatMap((store) =>
      profile.entries[store].map((entry) => ({
        store,
        entry_id: entry.entry_id,
        // 证据卡里**不截断**：旧实现截 160 字，而 methods 平均 141、最长 205，
        // failures 平均 185、最长 241 —— 专家经常只看到半句话。
        statement: entry.statement,
        ext: entry.ext,
        shared_with: entry.shared_with,
      })),
    )
    return [{
      paper_id: profile.paper_id,
      meta: {
        title: profile.meta.title,
        ...(profile.meta.year === undefined ? {} : { year: profile.meta.year }),
        ...(profile.meta.venue === undefined ? {} : { venue: profile.meta.venue }),
      },
      ...(profile.extraction === undefined ? {} : {
        extraction: {
          problem_statement: profile.extraction.problem_statement,
          method_summary: profile.extraction.method_summary,
          method_modules: profile.extraction.method_modules ?? [],
          innovations: profile.extraction.innovations,
          limitations: profile.extraction.limitations,
        },
      }),
      entries,
      modules: kb.searchModules({ paperId: candidate.paperId, limit: 50 })
        .map((module) => ({ module_id: module.module_id, name: module.name })),
      axis_ranks: candidate.ranks,
    }]
  })

  return {
    idea_id: idea.idea_id,
    axes: { problem_clusters: problemClusters, module_hits: moduleHits, method_candidates: methodEntries },
    candidates: candidates.map((candidate) => candidate.paperId),
    evidence_cards: evidenceCards,
    alignment_tasks: alignmentTasks,
    computed_at: new Date().toISOString(),
  }
}

/**
 * 把撞车报告渲染成**专家上下文**（三位专家共用；§5.2）。
 *
 * 两条纪律：
 * 1. **不出现相似度数字**——旧实现给裁判看 `sim=0.012`，而那个数字没有语义
 *    （同义改写给 0.004），LLM 看到小数字会倾向"不相关"，等于用噪声做锚定。
 * 2. 证据**不截断**：专家要读到完整的局限与结论。
 *
 * @param report - 撞车报告。
 * @param idea - 原 idea（渲染方法模块用）。
 * @param external - 外扩检索（Asta）回传的证据；**必须带给专家**，否则"外扩"白做。
 * @returns 一段可直接作为 prompt 的文本。
 */
export function renderCollisionContext(
  report: CollisionReport,
  idea: IdeaCandidate,
  external: readonly { ref_id: string; statement: string; similarity?: number }[] = [],
): string {
  const lines: string[] = []
  lines.push('[候选 idea]')
  if (idea.title !== undefined) lines.push(`标题：${idea.title}`)
  lines.push(`问题：${idea.problem}`)
  lines.push(`方法：${idea.method}`)
  lines.push(`预期创新：${idea.innovation}`)
  const modules = idea.method_modules ?? []
  if (modules.length > 0) {
    lines.push('')
    lines.push(`[idea 的方法模块 ${modules.length} 个]`)
    modules.forEach((module, index) => {
      lines.push(`${index + 1}. ${module.name}（${module.kind}）— ${module.role}`)
      lines.push(`   ${module.description}`)
    })
  }

  lines.push('')
  lines.push(`[库中候选论文 ${report.evidence_cards.length} 篇]`)
  for (const card of report.evidence_cards) {
    const ranks = Object.entries(card.axis_ranks).map(([axis, rank]) => `${axis}#${rank}`).join(' ')
    lines.push('')
    lines.push(`── ${card.paper_id}｜${card.meta.title}${card.meta.year === undefined ? '' : `（${card.meta.year}）`}｜命中轴：${ranks}`)
    if (card.extraction !== undefined) {
      lines.push(`   问题：${card.extraction.problem_statement}`)
      lines.push(`   方法：${card.extraction.method_summary}`)
      if (card.extraction.method_modules.length > 0) {
        lines.push(`   方法模块：${card.extraction.method_modules.map((m) => m.name).join(' / ')}`)
      }
      if (card.extraction.innovations.length > 0) {
        lines.push(`   创新点：${card.extraction.innovations.join('；')}`)
      }
      if (card.extraction.limitations.length > 0) {
        lines.push(`   局限：${card.extraction.limitations.join('；')}`)
      }
    } else {
      lines.push('   （该论文尚未提取，只有条目信息）')
    }
    const own = card.entries.filter((entry) => entry.shared_with === 0)
    const shared = card.entries.filter((entry) => entry.shared_with > 0)
    if (own.length > 0) lines.push(`   本篇独有条目：${own.map((entry) => `${entry.entry_id}(${entry.store})`).join(' ')}`)
    if (shared.length > 0) {
      lines.push(`   共享条目：${shared.map((entry) => `${entry.entry_id}(${entry.store}，另 ${entry.shared_with} 篇)`).join(' ')}`)
    }
  }

  lines.push('')
  lines.push(`[库里已有的候选模块]（对齐用；每条后面是用了它的论文）`)
  for (const task of report.alignment_tasks) {
    lines.push('')
    lines.push(`◆ idea 模块「${task.idea_module.name}」的候选：`)
    if (task.candidates.length === 0) lines.push('   （模块轴没有召回任何候选——可能是真新，也可能是措辞差异，请结合上面的论文证据判断）')
    for (const candidate of task.candidates.slice(0, 5)) {
      lines.push(`   - ${candidate.module_id}「${candidate.module_name}」${candidate.paper_ids.length > 0 ? `（论文 ${candidate.paper_ids.join('、')}）` : ''}`)
      lines.push(`     ${candidate.statement}`)
    }
  }

  // 外扩证据放在最后，并**明确标注来源不同**：库内证据是"我们自己归纳过的"，
  // 外扩证据只有题名/摘要要点，颗粒度不同——不标注的话专家会以为它和库内条目等价。
  if (external.length > 0) {
    lines.push('')
    lines.push(`[外扩检索证据 ${external.length} 条]（来自外部检索，非本地库；只有题名/摘要要点）`)
    for (const item of external) {
      lines.push(`- ${item.ref_id}：${item.statement}`)
    }
  }
  return lines.join('\n')
}
