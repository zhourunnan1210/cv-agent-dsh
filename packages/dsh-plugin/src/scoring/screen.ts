/**
 * 撞车粗筛（用户 2026-09-18 定的方向）：**让 LLM 读全库，不做文本相似度**。
 *
 * ## 为什么推翻原来的三轴关键词召回
 *
 * 原来的做法：把 idea 的问题/方法/模块切词，去四个库做 FTS5 关键词匹配，取 top-10 当候选。
 * 那套东西的前提是"**库很大，没法全看，得先缩小范围**"。实测库根本不 big：
 *
 * | 库位 | 条目 | 纯文本 |
 * | --- | --- | --- |
 * | 问题库 | 14 | 1144 字 |
 * | 模块清单 | 69 | 7349 字 |
 * | **本模块要读的两块** | **83** | **8493 字** |
 *
 * 8493 字塞进一个子代理的上下文，成本可以忽略。而关键词匹配不但没帮忙，还**主动扔掉**
 * 了"用词不同但意思相同"的论文——而那恰恰是最该抓的撞车（实测同义改写相似度 0.0039）。
 *
 * ## 两段式（本模块只管第一段）
 *
 * 1. **本模块（粗筛）**：一个子代理读「问题库 + 模块清单」全文 + idea → 返回**它认为相关的
 *    归纳条目编号**（`P002` / `MOD016`）；
 * 2. **第二段（`collide()` 已有）**：代码把条目编号展开成论文 → 取这几篇论文的方法/创新/
 *    失败条目 → 拼证据卡 → 交给打分专家细看。
 *
 * ## 两个刻意的决定
 *
 * **一、LLM 不返回论文编号，只返回条目编号。**
 * 如果让它直接返回论文索引，prompt 里就得带上"每条问题/模块对应哪些论文（含标题）"——
 * 实测光论文标题就把 prompt 从 8493 字撑到 **26797 字**（226 条关联 × 标题平均 85 字）。
 * 而让它返回条目编号有三个好处：prompt 小 3 倍；它**不可能编造论文编号**（它没见过）；
 * 条目→论文的展开走已经验证过的反向索引（`entry_sources` / `module_sources`）。
 *
 * **二、编号一律回库校验，对不上的丢掉并告警。**
 * LLM 会返回不存在的编号、也可能把年份当编号。**不能让假编号流到证据卡那一步**——
 * 那会变成"报告里引用了一篇不存在的论文"，而且没人看得出来。
 *
 * @module cv-agent-dsh/scoring-screen
 */

import type { ExpertRole } from '@cv-research/core'

import type { SubagentLike } from '../subagent.js'
import { SUBAGENT_MAX_DEPTH } from '../subagent.js'

/**
 * 粗筛子代理的工具面：**一个工具都不需要**。
 *
 * 它要判断的材料全在 prompt 里（问题库 + 模块清单全文），不需要检索、不需要读文件。
 * 给 `read` 只是沿用与专家一致的保守写法——真要给空列表，一旦语义被解释成"不过滤"
 * 就会把所有工具放开，那比多给一个 `read` 危险得多。
 */
export const SCREEN_TOOL_FILTER = { allow: ['read'] } as const

/** 粗筛子代理的角色。 */
export const SCREEN_PERSONA = [
  '你是 cv-research 的撞车粗筛子代理：只做**一件事**——从给定的一份"问题清单 + 做法模块清单"里，',
  '挑出与这条 idea 可能相关的条目。你不打分，也不下"是不是撞车"的结论。',
  '',
  '你要按**两个方向**找，两个方向同样重要：',
  '① **同一个问题**：清单里的问题条目，与这条 idea 要解决的问题是不是同一件事；',
  '② **同一个做法**：清单里的做法模块，与这条 idea 的某个模块是不是同一个机制。',
  '特别注意②：模块名不同不等于机制不同（"频域一致性约束"与"频率一致性正则"很可能是同一件事）；',
  '名字相同也可能用法不同。反过来也一样。',
  '',
  '判断时**宁松勿紧**：你的输出会交给后续环节细看，漏掉一条的代价比多报一条高得多——',
  '但也不要整份清单全报，那等于没筛。',
  '',
  '只输出结构化结果，不要输出自由文本。',
].join('\n')

/** 粗筛看到的问题条目。 */
export interface ScreenProblemView {
  readonly entry_id: string
  readonly statement: string
}

/** 粗筛看到的模块条目。 */
export interface ScreenModuleView {
  readonly module_id: string
  readonly name: string
  readonly statement: string
  readonly kinds: readonly string[]
}

/** 粗筛依赖的知识库读接口。 */
export interface ScreenKbPort {
  listProblems(): readonly ScreenProblemView[]
  listModules(): readonly ScreenModuleView[]
}

/** LLM 的结构化应答（schema 与本地校验共用一份形状）。 */
export function screenOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      matched_problems: {
        type: 'array',
        description: '与 idea 的问题可能相关的问题条目（用清单里给的编号，不要自己编）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entry_id: { type: 'string', description: '问题条目编号，如 P002' },
            why: { type: 'string', description: '为什么认为相关（一句话）' },
          },
          required: ['entry_id', 'why'],
        },
      },
      matched_modules: {
        type: 'array',
        description: 'idea 的每个模块各一条；该模块若在清单里找不到对应做法，library_modules 给空数组',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            idea_module: { type: 'string', description: 'idea 的模块名，与给你的名字一致' },
            library_modules: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  module_id: { type: 'string', description: '模块编号，如 MOD016' },
                  why: { type: 'string', description: '为什么认为机制相同（一句话）' },
                },
                required: ['module_id', 'why'],
              },
            },
          },
          required: ['idea_module', 'library_modules'],
        },
      },
      notes: { type: 'string', description: '可选：说明你为什么没选某些看起来相关的条目' },
    },
    required: ['matched_problems', 'matched_modules'],
  }
}

/** 粗筛结果（已回库校验）。 */
export interface ScreeningResult {
  readonly problems: readonly { entry_id: string; statement: string; why: string }[]
  readonly modules: readonly {
    readonly idea_module: string
    readonly module_id: string
    readonly name: string
    readonly statement: string
    readonly why: string
  }[]
  /**
   * LLM 报了但**库里没有**的编号（编造的）。
   *
   * 必须透出到报告里：这是"模型在编"的直接证据，静默丢弃会让人以为它从没编过。
   */
  readonly dropped: readonly { kind: 'problem' | 'module'; id: string }[]
  /** 本次塞进 prompt 的字数（审计：成本可见）。 */
  readonly prompt_chars: number
  /** idea 的模块里，LLM **一条候选都没给**的那些（真新 / 或它没看懂，两者要人去分辨）。 */
  readonly unmatched_idea_modules: readonly string[]
}

/** 把「问题库 + 模块清单 + idea」渲染成粗筛 prompt。 */
export function renderScreenContext(
  idea: { readonly statement: string; readonly problem: string; readonly method: string; readonly innovation: string; readonly method_modules?: readonly { name: string; role: string; description: string; kind: string }[] },
  problems: readonly ScreenProblemView[],
  modules: readonly ScreenModuleView[],
): string {
  const lines: string[] = []
  lines.push('[待评估的 idea]')
  lines.push(`陈述：${idea.statement}`)
  lines.push(`问题：${idea.problem}`)
  lines.push(`方法：${idea.method}`)
  lines.push(`预期创新：${idea.innovation}`)
  const ideaModules = idea.method_modules ?? []
  if (ideaModules.length > 0) {
    lines.push('')
    lines.push(`[这条 idea 的方法模块 ${ideaModules.length} 个]`)
    ideaModules.forEach((module, index) => {
      lines.push(`${index + 1}. ${module.name}（${module.kind}）— ${module.role}`)
      lines.push(`   ${module.description}`)
    })
  }

  lines.push('')
  lines.push(`[问题清单：${problems.length} 条]（每条前面是编号，返回时用这个编号）`)
  for (const problem of problems) {
    lines.push(`- ${problem.entry_id}｜${problem.statement}`)
  }

  lines.push('')
  lines.push(`[做法模块清单：${modules.length} 条]（每条前面是编号，返回时用这个编号）`)
  for (const module of modules) {
    lines.push(`- ${module.module_id}｜${module.name}${module.kinds.length > 0 ? `（${module.kinds.join('/')}）` : ''}：${module.statement}`)
  }

  lines.push('')
  lines.push('[任务]')
  lines.push('1. 从问题清单里挑出与这条 idea 的**问题**可能相关的条目（`matched_problems`）。')
  lines.push('2. 对这条 idea 的**每一个模块**，从做法模块清单里挑出机制可能相同的条目（`matched_modules`）。')
  lines.push('   每个 idea 模块都要在 `matched_modules` 里出现一次；确实找不到对应的就给空数组。')
  lines.push('3. **只用上面清单里出现过的编号**，不要自己编编号。')
  lines.push('不要下"是否撞车"的结论，那是后续环节的事。')
  return lines.join('\n')
}

/** 宽松形状校验：形状不对的条目丢弃，而不是让整轮崩。 */
export function coerceScreening(value: unknown): {
  matched_problems: { entry_id: string; why: string }[]
  matched_modules: { idea_module: string; library_modules: { module_id: string; why: string }[] }[]
} {
  const record = (value ?? {}) as Record<string, unknown>

  const matched_problems: { entry_id: string; why: string }[] = []
  if (Array.isArray(record.matched_problems)) {
    for (const item of record.matched_problems) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const id = typeof entry.entry_id === 'string' ? entry.entry_id.trim() : ''
      if (id === '') continue
      matched_problems.push({ entry_id: id, why: typeof entry.why === 'string' ? entry.why : '' })
    }
  }

  const matched_modules: { idea_module: string; library_modules: { module_id: string; why: string }[] }[] = []
  if (Array.isArray(record.matched_modules)) {
    for (const item of record.matched_modules) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const ideaModule = typeof entry.idea_module === 'string' ? entry.idea_module.trim() : ''
      if (ideaModule === '') continue
      const libraryModules: { module_id: string; why: string }[] = []
      if (Array.isArray(entry.library_modules)) {
        for (const candidate of entry.library_modules) {
          if (typeof candidate !== 'object' || candidate === null) continue
          const record2 = candidate as Record<string, unknown>
          const id = typeof record2.module_id === 'string' ? record2.module_id.trim() : ''
          if (id === '') continue
          libraryModules.push({ module_id: id, why: typeof record2.why === 'string' ? record2.why : '' })
        }
      }
      matched_modules.push({ idea_module: ideaModule, library_modules: libraryModules })
    }
  }

  return { matched_problems, matched_modules }
}

/**
 * 回库校验：把 LLM 报的编号收敛成真实条目，编造的丢掉并留痕。
 *
 * @param value - LLM 的结构化应答。
 * @param problems - 问题库全量（校验用）。
 * @param modules - 模块清单全量（校验用）。
 * @param ideaModules - idea 自己的模块名（用来发现"漏报的模块"）。
 * @param promptChars - 本次 prompt 字数（审计）。
 */
export function resolveScreening(
  value: unknown,
  problems: readonly ScreenProblemView[],
  modules: readonly ScreenModuleView[],
  ideaModules: readonly string[],
  promptChars: number,
): ScreeningResult {
  const raw = coerceScreening(value)
  const problemById = new Map(problems.map((problem) => [problem.entry_id, problem]))
  const moduleById = new Map(modules.map((module) => [module.module_id, module]))

  const dropped: { kind: 'problem' | 'module'; id: string }[] = []
  const seenProblem = new Set<string>()
  const keptProblems: { entry_id: string; statement: string; why: string }[] = []
  for (const item of raw.matched_problems) {
    const found = problemById.get(item.entry_id)
    if (found === undefined) {
      dropped.push({ kind: 'problem', id: item.entry_id })
      continue
    }
    if (seenProblem.has(item.entry_id)) continue
    seenProblem.add(item.entry_id)
    keptProblems.push({ entry_id: found.entry_id, statement: found.statement, why: item.why })
  }

  const keptModules: { idea_module: string; module_id: string; name: string; statement: string; why: string }[] = []
  const covered = new Set<string>()
  for (const group of raw.matched_modules) {
    if (group.library_modules.length > 0) covered.add(group.idea_module)
    const seen = new Set<string>()
    for (const candidate of group.library_modules) {
      const found = moduleById.get(candidate.module_id)
      if (found === undefined) {
        dropped.push({ kind: 'module', id: candidate.module_id })
        continue
      }
      if (seen.has(candidate.module_id)) continue
      seen.add(candidate.module_id)
      keptModules.push({
        idea_module: group.idea_module,
        module_id: found.module_id,
        name: found.name,
        statement: found.statement,
        why: candidate.why,
      })
    }
  }

  // 漏报的 idea 模块：LLM 没给任何候选（真新，或者它没看懂——两者要人去分辨）
  const unmatched = ideaModules.filter((name) => !covered.has(name))

  return {
    problems: keptProblems,
    modules: keptModules,
    dropped,
    prompt_chars: promptChars,
    unmatched_idea_modules: unmatched,
  }
}

/** `screenCandidates` 的入参。 */
export interface ScreenOptions {
  readonly ideaId: string
  readonly idea: Parameters<typeof renderScreenContext>[0]
  readonly kb: ScreenKbPort
  readonly agent: unknown
  readonly signal: AbortSignal
}

/** 粗筛跑不出来时的原因（上层据此决定是否退回关键词召回）。 */
export interface ScreenFailure {
  readonly error: string
}

/**
 * 跑一次粗筛：组装 prompt → 委派**一个**子代理 → 回库校验。
 *
 * 只派一个子代理：这一步是"读清单挑条目"，三个专家那套交叉验证用在这里没有意义——
 * 粗筛宁可松一点，把细看的活留给后面的专家。
 *
 * @returns 校验后的粗筛结果；委派失败或不按契约应答时返回 `{ error }`。
 */
export async function screenCandidates(
  subagents: SubagentLike,
  options: ScreenOptions,
): Promise<ScreeningResult | ScreenFailure> {
  const problems = [...options.kb.listProblems()]
  const modules = [...options.kb.listModules()]
  const ideaModules = (options.idea.method_modules ?? []).map((module) => module.name)
  const context = renderScreenContext(options.idea, problems, modules)

  let run
  try {
    run = await subagents.start('spawn', {
      signal: options.signal,
      parent: options.agent,
      label: `screen:${options.ideaId}`,
      prompt: [{ type: 'text', text: context }],
      toolFilter: SCREEN_TOOL_FILTER,
      persona: SCREEN_PERSONA,
      outputSchema: screenOutputSchema(),
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
    return resolveScreening(result.structured, problems, modules, ideaModules, context.length)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    await run.dispose()
  }
}

/** 面板/报告用的专家角色再导出（避免调用方多引一个模块）。 */
export type { ExpertRole }
