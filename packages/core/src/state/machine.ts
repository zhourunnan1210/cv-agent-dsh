/**
 * 大 Loop 状态机与门控逻辑（平台无关，纯函数）。
 *
 * 设计依据：v1.2 文档 §4、§9.1、§9.3，以及勘误文档
 * `docs/CV-Research-Agent_勘误与修订设计-v1.3.md` §4.3 的**修订**门控设计。
 *
 * ## 为什么本文件与 v1.2 §10 的接口不同
 *
 * v1.2 §10 把 `advance()` 描述为「触发 gate / 事件」，并把
 * `cvagent.gate.request` 描述为「向用户呈现阶段摘要并等待选择；A 模式阻塞」。
 * 工具调用无法在单次执行内等待用户输入，这是模型-工具协议的结构性限制。
 *
 * 因此门控被拆成三段（勘误 §4.3）：
 *
 * 1. `requestGate()` —— 判定阶段出口，写入待决 gate 状态；
 * 2. **呈递** —— 由 dsh 侧调用 `ask_user_question` 完成，**不在本层**；
 * 3. `resolveGate()` —— 落盘用户决议，`advance()` 据模式决定是否推进。
 *
 * 本层只实现 1 和 3，且是**纯函数**：不碰文件、不调 LLM、不依赖 dsh。
 * 副作用（读写 `project_state.json`、发事件）落在 `packages/dsh-plugin`。
 */

/** 大 Loop 阶段（v1.2 §9.1）。 */
export type Stage = 'knowledge_building' | 'idea_generation' | 'idea_scoring' | 'experiment' | 'writing'

/** 阶段顺序，`advance` 依此推进。 */
export const STAGE_ORDER = [
  'knowledge_building',
  'idea_generation',
  'idea_scoring',
  'experiment',
  'writing',
] as const satisfies readonly Stage[]

/** 自主性治理模式（v1.2 §4.1）。 */
export type Mode = 'confirm' | 'supervised' | 'full_auto'

/** 阶段状态。 */
export type StageStatus = 'pending' | 'in_progress' | 'awaiting_gate' | 'completed' | 'failed'

/** 单个阶段的记录。 */
export interface StageRecord {
  readonly status: StageStatus
  /** 阶段产出的自由摘要，供呈递与审计。 */
  readonly summary?: string
  readonly completed_at?: string
  /** 完成后自动快照的回滚点标识（v1.2 §9.1）。 */
  readonly rollback_point?: string
}

/**
 * 待决 gate。
 *
 * 存在该字段即表示「阶段出口已判定达标，等待决议」。
 * A 模式必须经呈递取得决议后才能推进；B/C 模式按策略自动放行。
 */
export interface PendingGate {
  readonly stage: Stage
  /** 呈递给用户的阶段摘要。 */
  readonly summary: string
  /** 可选项，如 `['advance', 'revise', 'rollback']`。 */
  readonly options: readonly string[]
  readonly requested_at: string
}

/** 已决议的 gate 记录，保留供审计。 */
export interface ResolvedGate {
  readonly stage: Stage
  readonly decision: string
  readonly comment?: string
  readonly resolved_at: string
  /** 决议后是否实际推进了阶段。 */
  readonly advanced: boolean
}

/** 项目状态（`project_state.json` 的内存形态，v1.2 §9.1）。 */
export interface ProjectState {
  readonly project_id: string
  readonly current_stage: Stage
  /** `null` 表示会话尚未确定模式，dsh 侧应主动询问一次并落盘（勘误 §4.3）。 */
  readonly mode: Mode | null
  /**
   * 研究范围（P3-4 新增）：与用户对话确定的**细分领域**及其检索关键词组。
   *
   * 为什么落盘而不是留在对话里：Scout 委派、Domain Pack 生成、idea 生成都要用它；
   * 而会话历史会被压缩（E 系列教训），落盘才是不lost 的载体。`null` 表示尚未确定。
   */
  readonly sub_domain: string | null
  /** 关键词组（用于检索扩展；缺省时用 Domain Pack 的 `lexicon.query_expansion`）。 */
  readonly keywords: readonly string[]
  /**
   * 换课题时的存量快照（方案 C）。`null` = 沿用绝对口径。
   *
   * 为什么需要它：语料跨课题沿用，而判据读绝对总量会让"知识建成"被历史存量顶过。
   * 记下基线后，知识阶段的判据只认**本课题新增**。
   */
  readonly scope_baseline?: ScopeBaseline | null
  /**
   * 本课题的语料策略（用户裁定）：`extend`（默认，只认新增）/ `reuse`（沿用存量，不再扩充）。
   *
   * `undefined` 也按 `extend` 处理，同时是"这条状态来自升级前的代码"的判据
   * （见 `setResearchScope` 的 legacy 分支与判据里的补记提示）。
   */
  readonly corpus_mode?: CorpusMode
  readonly stages: Readonly<Partial<Record<Stage, StageRecord>>>
  readonly pending_gate: PendingGate | null
  readonly resolved_gates: readonly ResolvedGate[]
  readonly rollback_points: readonly string[]
}

/** 阶段出口判定结果。 */
export interface GateDecision {
  /** 完成判据是否全部满足。 */
  readonly satisfied: boolean
  /** 未满足项清单，直接回传给 Agent 作为「缺什么」的说明。 */
  readonly missing: readonly string[]
  /** 满足判据时，写入待决状态的 gate；不满足时为 `null`。 */
  readonly gate: PendingGate | null
}

/** 单个阶段的完成判据（v1.2 §9.3）。 */
export interface GateCriteria {
  /** 判据逐项求值；返回未满足项。 */
  evaluate(state: ProjectState): readonly string[]
}

/**
 * 判定阶段出口（勘误 §4.3 第 ① 步）。
 *
 * 纯函数：只读取状态与判据，产出「是否达标 + 待决 gate」。
 * **不修改传入的 state**，调用方（dsh 侧）负责落盘。
 *
 * @param state - 当前项目状态。
 * @param criteria - 当前阶段的完成判据。
 * @param now - ISO 时间戳，注入以便测试。
 * @returns 判定结果；`gate` 非空时调用方应将其写入状态并（按模式）呈递。
 */
export function requestGate(
  state: ProjectState,
  criteria: GateCriteria,
  now: string,
  summary: string,
): GateDecision {
  const missing = criteria.evaluate(state)
  if (missing.length > 0) return { satisfied: false, missing, gate: null }
  return {
    satisfied: true,
    missing: [],
    gate: {
      stage: state.current_stage,
      summary,
      options: ['advance', 'revise', 'rollback'],
      requested_at: now,
    },
  }
}

/**
 * 判断某模式下的 gate 是否需要人工决议（勘误 §4.3 表）。
 *
 * - `confirm`：必须呈递并等待用户答复后才推进；
 * - `supervised`：不主动询问，但记录 gate，用户可主动介入；
 * - `full_auto`：自动放行，记入报告。
 *
 * 该判定与「是否呈递」解耦：呈递本身由 dsh 侧实现，本函数只回答
 * **需不需要人**。这使得「无人在场时 A 模式会卡住」成为显式语义而非意外。
 */
export function requiresHumanDecision(mode: Mode | null): boolean {
  // 模式未定时保守处理：按 confirm 对待，促使 dsh 侧先问一次。
  return mode === null || mode === 'confirm'
}

/**
 * 落盘决议并推进（勘误 §4.3 第 ③ 步）。
 *
 * 纯函数：返回新状态，不修改传入对象。
 *
 * 语义边界：
 * - 无待决 gate 时视为调用方错误，抛出（而非静默推进）；
 * - `decision` 非 `advance`（即 `revise` / `rollback`）时**不推进阶段**，
 *   只清除 gate 并记录，由调用方按 `decision` 决定后续动作；
 * - `advance` 时把当前阶段置为 `completed`、写入回滚点，并把
 *   `current_stage` 移到下一阶段；已是最后阶段则停在 `writing` 并标记完成。
 *
 * @throws 当 `state.pending_gate` 为空时。
 */
export function resolveGate(state: ProjectState, decision: string, comment: string | undefined, now: string): ProjectState {
  const gate = state.pending_gate
  if (gate === null) {
    throw new Error(`resolveGate: 阶段 ${state.current_stage} 没有待决 gate，不能落盘决议`)
  }

  const advanced = decision === 'advance'
  const currentIndex = STAGE_ORDER.indexOf(state.current_stage)
  const nextStage = STAGE_ORDER[currentIndex + 1]

  const completedRecord: StageRecord = {
    status: 'completed',
    ...(gate.summary === '' ? {} : { summary: gate.summary }),
    completed_at: now,
    rollback_point: `after_${gate.stage}`,
  }

  const previousRecord = state.stages[gate.stage] ?? { status: 'in_progress' as const }
  const stages: Partial<Record<Stage, StageRecord>> = {
    ...state.stages,
    [gate.stage]: advanced ? completedRecord : { ...previousRecord, status: 'in_progress' },
  }
  if (advanced && nextStage !== undefined) {
    stages[nextStage] = stages[nextStage] ?? { status: 'pending' }
  }

  const resolved: ResolvedGate = {
    stage: gate.stage,
    decision,
    ...(comment === undefined ? {} : { comment }),
    resolved_at: now,
    advanced,
  }

  return {
    ...state,
    current_stage: advanced && nextStage !== undefined ? nextStage : state.current_stage,
    stages,
    pending_gate: null,
    resolved_gates: [...state.resolved_gates, resolved],
    rollback_points: advanced ? [...state.rollback_points, `after_${gate.stage}`] : state.rollback_points,
  }
}

/**
 * 创建初始状态。
 *
 * @param projectId - 项目标识。
 * @param mode - 初始模式；`null` 表示待 dsh 侧询问一次后落盘。
 */
export function createProjectState(projectId: string, mode: Mode | null = null): ProjectState {
  return {
    project_id: projectId,
    current_stage: 'knowledge_building',
    mode,
    sub_domain: null,
    keywords: [],
    stages: { knowledge_building: { status: 'pending' } },
    pending_gate: null,
    resolved_gates: [],
    rollback_points: [],
  }
}

/**
 * 本课题怎么建语料（**由用户裁定**，不是 agent 自己决定）。
 *
 * - `extend`（默认）：沿用存量 + **只认新增**。落盘范围时记基线，门控要求本课题补足新语料。
 * - `reuse`：用户认为现有语料已覆盖本课题，**不再扩充**；门控回到绝对口径（存量算数）。
 *
 * 为什么要有 `reuse`：本地库已经很丰富时，"再检索→下载→解析→提取→归档"未必必要，
 * 硬跑一遍是浪费（MinerU 额度、时间、还有误入库的风险）。但**不能靠模型自行判断**
 * ——那等于把门控交回给它自己。所以模型必须**用白话问用户**，用户答"沿用现有的"，
 * 才由 `cvagent_scope_set(reuse_existing=true)` 落成这个状态（可审计）。
 */
export type CorpusMode = 'extend' | 'reuse'

/**
 * 落盘研究范围（P3-4）：细分领域 + 关键词组。
 *
 * 纯函数。`keywords` 去重去空、保留顺序；`sub_domain` 去空白，空串视为 `null`
 * （"没填"与"填了空字符串"必须归一到同一个状态，否则下游要判两次）。
 *
 * ## 口径基线（用户 2026-09-17 裁定，方案 C）
 *
 * 换课题时，语料是**沿用**的（去重、引用、已解析全文都要用），但门控判据读的是绝对总量
 * ——于是"知识建成"会被上一个课题的存量直接顶过，门控变成形式。
 *
 * 解法：范围**真的变了**时，记下此刻的存量快照（`scope_baseline`），此后知识阶段的判据
 * 只认**相对基线的增量**。范围没变（重复落盘同一范围）则**不动**基线——否则每次
 * `scope_set` 都会把进度清零。
 *
 * 快照是**惰性求值**的：`snapshot` 只在确实要记基线时才被调用，避免每次落盘都去查库。
 *
 * ## `corpusMode`：用户说"这批够用了，别再找了"时的出口
 *
 * 本地库已经很丰富时，硬跑一遍"检索→下载→解析→提取→归档"未必必要。但**不能由模型
 * 自行判断**——那等于把门控交回给它自己。所以模型要用白话问用户，用户答"沿用现有的"，
 * 才落成 `reuse`（见 {@link CorpusMode}）：此时基线清空、判据回到绝对口径。
 *
 * @param state - 当前状态。
 * @param scope - 本次要落盘的范围（字段缺省 = 保持原值）。
 * @param now - ISO 时间戳（注入以便测试）。
 * @param snapshot - 存量快照供应函数；仅在需要记基线时调用。
 * @param corpusMode - 语料策略（缺省保持原值，从未设过则是 `extend`）。
 */
export function setResearchScope(
  state: ProjectState,
  scope: { readonly sub_domain?: string | null; readonly keywords?: readonly string[] },
  now: string = new Date().toISOString(),
  snapshot?: () => ScopeBaselineCounts,
  corpusMode?: CorpusMode,
): ProjectState {
  const subDomain = scope.sub_domain === undefined
    ? state.sub_domain
    : (scope.sub_domain === null || scope.sub_domain.trim() === '' ? null : scope.sub_domain.trim())
  const keywords = scope.keywords === undefined
    ? state.keywords
    : [...new Set(scope.keywords.map((item) => item.trim()).filter((item) => item !== ''))]

  const mode: CorpusMode = corpusMode ?? state.corpus_mode ?? 'extend'
  const modeChanged = mode !== (state.corpus_mode ?? 'extend')
  const changed = subDomain !== state.sub_domain || !sameKeywords(keywords, state.keywords)
  /**
   * 基线字段**缺失**（`undefined`）= 这条状态由升级前的代码写入。
   *
   * 此时即便范围没变也要补记一次基线：否则老状态会永远停在"绝对口径"，
   * 而它恰恰是最需要基线的那些状态（范围早已落盘、存量早已存在）。
   * 注意与 `null` 的区别：`null` 是"明确没有基线"，不再重复补记。
   */
  const legacy = state.corpus_mode === undefined && state.scope_baseline === undefined

  // 用户裁定"沿用存量、不再扩充"：不需要基线，判据回到绝对口径。
  if (mode === 'reuse') {
    if (!changed && !modeChanged && state.scope_baseline === null) {
      return { ...state, sub_domain: subDomain, keywords, corpus_mode: mode }
    }
    return { ...state, sub_domain: subDomain, keywords, corpus_mode: mode, scope_baseline: null }
  }

  // `extend`：范围没变、策略没变、基线也在 → 什么都不动（重复落盘不清零进度）。
  if (!changed && !modeChanged && !legacy) {
    return { ...state, sub_domain: subDomain, keywords, corpus_mode: mode }
  }

  // 范围被清空：没有基线可言（下次落范围时会重新记）。
  if (subDomain === null && keywords.length === 0) {
    return { ...state, sub_domain: subDomain, keywords, corpus_mode: mode, scope_baseline: null }
  }

  const baseline: ScopeBaseline | null = snapshot === undefined
    ? null
    : { recorded_at: now, sub_domain: subDomain, keywords, ...snapshot() }
  return { ...state, sub_domain: subDomain, keywords, corpus_mode: mode, scope_baseline: baseline }
}

function sameKeywords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * 换课题时记下的**存量快照**（方案 C 的口径基线）。
 *
 * 知识阶段的判据据此改判"相对基线的新增"，而不是绝对总量：
 * `papers - baseline.papers >= min_papers`。
 * 没有基线（新项目）时退回绝对口径，行为与加基线之前一致。
 */
export interface ScopeBaselineCounts {
  readonly papers: number
  readonly parsed: number
  readonly extractions: number
  readonly entries: Readonly<Record<string, number>>
}

export interface ScopeBaseline extends ScopeBaselineCounts {
  readonly recorded_at: string
  /** 记录基线时的范围，便于人工核对"这条基线是哪次课题的"。 */
  readonly sub_domain: string | null
  readonly keywords: readonly string[]
}

/**
 * 阶段判据所需的**事实**（由 dsh 侧从知识库/委派结果计算后注入）。
 *
 * 为什么事实由外部注入而不是本层去查：core 是平台无关的纯逻辑层，
 * 不碰数据库；而判据必须是**真实数字**而不是模型自报——所以由 dsh 侧的服务
 * 直接从 kb 读，模型没有机会虚报。
 */
export interface StageFacts {
  /** 论文库总条数。 */
  readonly papers: number
  /** 已解析全文的论文数。 */
  readonly parsed: number
  /** 已完成 Reader 结构化提取的论文数。 */
  readonly extractions: number
  /** 四库条目数（problems/methods/innovations/failures）。 */
  readonly entries: Readonly<Record<string, number>>
  /** 已生成的候选 idea 数（缺省 0）。 */
  readonly ideas_generated?: number
  /** 已打分的 idea 数（缺省 0）。 */
  readonly ideas_scored?: number
  /** 已收敛（有 RESULTS）的实验数（缺省 0）。 */
  readonly experiments?: number
}

/** 各阶段的判据阈值（缺省即 v1.2 §9.3 的量化口径，可在项目配置里覆盖）。 */
export interface CriteriaThresholds {
  readonly knowledge_building: {
    /** 论文库下限（v1.2 §14 的 Phase 2 验收口径是 ≥100 篇）。 */
    readonly min_papers: number
    readonly min_parsed: number
    /** 抽检口径：P2-7 的"抽检 20 篇"就是提取数下限。 */
    readonly min_extractions: number
    /** 四库各自的条目下限。 */
    readonly min_problems: number
    readonly min_methods: number
    readonly min_innovations: number
    /** 失败方法库下限（idea 复查的前提：库里得有东西可查）。 */
    readonly min_failures: number
  }
  readonly idea_generation: {
    readonly min_candidates: number
  }
  readonly idea_scoring: {
    readonly min_scored: number
  }
  readonly experiment: {
    readonly min_experiments: number
  }
  readonly writing: {
    /** 写作阶段不设下限：由人工门控把关（交付物形态差异太大）。 */
    readonly min_drafts: number
  }
}

/** 默认阈值。 */
export const DEFAULT_CRITERIA: CriteriaThresholds = {
  knowledge_building: {
    min_papers: 100,
    min_parsed: 50,
    min_extractions: 20,
    min_problems: 5,
    min_methods: 5,
    min_innovations: 10,
    min_failures: 5,
  },
  idea_generation: { min_candidates: 3 },
  idea_scoring: { min_scored: 1 },
  experiment: { min_experiments: 1 },
  writing: { min_drafts: 0 },
}

/**
 * 按阶段判据求值（纯函数）：返回**未满足项清单**（空数组 = 达标）。
 *
 * 设计要点：
 * - 缺什么就明确说缺什么（含"当前/要求"两个数字），因为这份清单会直接回传给 Agent 与用户；
 * - 判据是可量化的真实事实，**不接受模型自报**（见 `StageFacts`）；
 * - `sub_domain` 未确定时，知识阶段即便数字达标也不放行——检索范围没定就谈"知识建成"没有意义；
 * - **有口径基线时（方案 C），知识阶段的数字一律按"相对基线的新增"算**：语料跨课题沿用，
 *   若仍读绝对总量，上一个课题的存量会把门控直接顶过。清单里同时给出存量与基线，便于核对
 *   （"新增 12/100 篇（存量 390，基线 378）"——一眼能看出门控在量什么）。
 */
export function evaluateCriteria(
  state: ProjectState,
  facts: StageFacts,
  thresholds: CriteriaThresholds = DEFAULT_CRITERIA,
): readonly string[] {
  const missing: string[] = []
  /**
   * 口径基线的**实际生效值**。
   *
   * 用户裁定"沿用存量"（`corpus_mode === 'reuse'`）时一律按绝对口径——存量为零的基线
   * 在这里表达"没有基线"，比到处判两次模式清楚。
   */
  const baseline = state.corpus_mode === 'reuse' ? null : (state.scope_baseline ?? null)

  /**
   * 一个计数的"本课题口径"描述：无基线时是绝对值；有基线时是增量，
   * 并附带存量与基线以便核对。
   *
   * @param current - 当前绝对计数。
   * @param base - 基线计数（无基线传 0）。
   * @returns 当前口径下的分子，以及用于展示的后缀。
   */
  const gauge = (current: number, base: number): { value: number; suffix: string } => {
    if (baseline === null) return { value: current, suffix: '' }
    return { value: current - base, suffix: `（存量 ${current}，基线 ${base}）` }
  }

  const entryCount = (store: string): number => facts.entries[store] ?? 0
  const entryBase = (store: string): number => baseline?.entries[store] ?? 0

  /** 无基线时用绝对口径的原措辞；有基线时在名称后加"新增"，避免出现两个空格。 */
  const name = (label: string): string => (baseline === null ? label : `${label}新增`)

  switch (state.current_stage) {
    case 'knowledge_building': {
      const limits = thresholds.knowledge_building
      if (state.sub_domain === null) missing.push('研究范围未确定（sub_domain 为空）：先用 cvagent_scope_set 落盘细分领域与关键词')
      // 升级前的状态没有基线字段。此时绝对口径会把存量当成本课题成果——
      // **宁可卡住也不误放**：让人再落一次范围，在存量上划出本课题的起点。
      // 用户已明确裁定"沿用存量"（reuse）时不提示：那是知情的决定，不是遗漏。
      if (state.sub_domain !== null && state.corpus_mode !== 'reuse' && state.scope_baseline === undefined) {
        missing.push('口径基线未记录（本状态由升级前写入）：再调一次 cvagent_scope_set（含本课题范围）以在现有存量上划出起点')
      }
      const papers = gauge(facts.papers, baseline?.papers ?? 0)
      if (papers.value < limits.min_papers) {
        missing.push(`${name('论文库')} ${papers.value}/${limits.min_papers} 篇${papers.suffix}`)
      }
      const parsed = gauge(facts.parsed, baseline?.parsed ?? 0)
      if (parsed.value < limits.min_parsed) {
        missing.push(`${name('已解析全文')} ${parsed.value}/${limits.min_parsed} 篇${parsed.suffix}`)
      }
      const extractions = gauge(facts.extractions, baseline?.extractions ?? 0)
      if (extractions.value < limits.min_extractions) {
        missing.push(`${name('结构化提取（抽检口径）')} ${extractions.value}/${limits.min_extractions} 篇${extractions.suffix}`)
      }

      const entryChecks: ReadonlyArray<readonly [string, string, number]> = [
        ['problems', '问题卡', limits.min_problems],
        ['methods', '方法卡', limits.min_methods],
        ['innovations', '创新卡', limits.min_innovations],
        ['failures', '失败方法库', limits.min_failures],
      ]
      for (const [store, label, limit] of entryChecks) {
        const count = gauge(entryCount(store), entryBase(store))
        if (count.value < limit) {
          missing.push(`${name(label)} ${count.value}/${limit} 条${count.suffix}`)
        }
      }
      break
    }
    case 'idea_generation': {
      const ideas = facts.ideas_generated ?? 0
      if (ideas < thresholds.idea_generation.min_candidates) {
        missing.push(`候选 idea ${ideas}/${thresholds.idea_generation.min_candidates} 条（cvagent_idea_generate）`)
      }
      break
    }
    case 'idea_scoring': {
      const scored = facts.ideas_scored ?? 0
      if (scored < thresholds.idea_scoring.min_scored) {
        missing.push(`已打分 idea ${scored}/${thresholds.idea_scoring.min_scored} 条（cvagent_idea_score）`)
      }
      break
    }
    case 'experiment': {
      const experiments = facts.experiments ?? 0
      if (experiments < thresholds.experiment.min_experiments) {
        missing.push(`已收敛实验 ${experiments}/${thresholds.experiment.min_experiments} 个（experiments/ 下需有 RESULTS.md）`)
      }
      break
    }
    case 'writing': {
      if (thresholds.writing.min_drafts > 0) {
        missing.push(`草稿数未达下限 ${thresholds.writing.min_drafts}（当前不设下限，此分支保留）`)
      }
      break
    }
  }
  return missing
}
