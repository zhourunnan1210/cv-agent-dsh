/**
 * Idea 族工具（P3-3b）：`cvagent_idea_generate` 与 `cvagent_idea_score`。
 *
 * 分工（勘误 §11.2，用户 2026-09-17 裁定；整合设计 v1.0 §6 修订）：
 * - **生成**：N 个不同视角的 Generator 子代理并发产出 → 主 Agent 侧合并去重（视角标记保留）；
 * - **打分**：确定性召回（`ideaScore` 服务）→ 边界带命中则**外扩 Asta**（由主 Agent 执行检索后回传）
 *   → **三专家面板**（方法/评测/领域，并行、互不可见）各自判模块级对齐并给四维分
 *   → 分歧触发**一轮**讨论 → 中位数聚合 → 失败库复查结论。
 *
 * 单裁判链路（一个 LLM 逐条判 collision、分数由字符相似度算出）已被面板取代：
 * 同义改写的相似度只有 0.0039，那条链路会把真撞车判成满分新颖。
 *
 * 本行是 `ideaScore` 与 `kb` 的消费者，必须与它们同处一个 isolate group（§4.4.1）。
 *
 * @module cv-agent-dsh/idea-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import { GRANULARITY, normalizeTitle, renderGranularityPrompt, type IdeaCandidate, type IdeaModule, type MethodModuleKind, type PanelAudit } from '@cv-research/core'

import { IDEA_TOOLS } from '../tools/names.js'
import type { IdeaScoreService } from './service.js'
import { SUBAGENT_MAX_DEPTH } from '../subagent.js'
import type { SubagentLike } from '../subagent.js'
import { renderCollisionContext, type CollisionReport } from './collide.js'
import { runExpertPanel } from './panel.js'
import { screenCandidates } from './screen.js'

export const name = 'cvagent-idea-tools'
export const inject = ['ideaScore', 'kb', 'tools']

/**
 * Generator 子代理的最小工具面：只给**知识库只读检索**。
 *
 * 刻意不给 `cvagent_kb_upsert_entry`（生成阶段不该写库）与 `read`（不需要读原文，
 * 三库条目已是归纳产物；要细节留给 Analyst）。这既是隔离红线，也防止 Generator
 * 把上下文浪费在读文件上。
 */
export const GENERATOR_TOOL_FILTER = { allow: ['cvagent_kb_search', 'cvagent_kb_summary'] } as const

/** Generator 角色 persona（§16.2 五段式的角色段）。 */
export const GENERATOR_PERSONA = [
  '你是 cv-research 的 Idea Generator 子代理：只负责在**给定的一个视角**内提出候选研究 idea。',
  '你手上只有知识库只读检索工具（cvagent_kb_search / cvagent_kb_summary）：',
  '先用它们查看该视角下的问题卡、方法卡、创新卡与失败方法库，再提出候选。',
  '每个候选要写清：一句话陈述、面向的问题、拟采用的方法、预期创新点、1–3 篇建议 baseline 论文 ID。',
  '禁止提出已被失败方法库明确否定的做法；若你认为某条失败的条件已变，必须在该候选里说明理由。',
  '只输出结构化结果，不要输出自由文本。',
].join(' ')

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

/** 候选 idea 的 outputSchema（Generator 用）。 */
export function ideaOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ideas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: '一句话标题' },
            statement: { type: 'string', description: `一句话说清这个想法（${GRANULARITY.problem.min}–${GRANULARITY.problem.max} 字）` },
            problem: { type: 'string', description: `它要解决什么问题：${GRANULARITY.problem.min}–${GRANULARITY.problem.max} 字（${GRANULARITY.problem.requirement}）` },
            method: { type: 'string', description: `方法整体叙述：${GRANULARITY.method.min}–${GRANULARITY.method.max} 字（${GRANULARITY.method.requirement}）` },
            // ★ 与论文侧 method_modules 同构：撞车的对齐单元
            method_modules: {
              type: 'array',
              description: '方法的组成拆解（3–6 个）——与论文库的模块清单**逐条对齐**用',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', description: '可命名的模块名' },
                  role: { type: 'string', description: '一句话：它在整体里干什么' },
                  description: { type: 'string', description: `输入/操作/作用：${GRANULARITY.module_description.min}–${GRANULARITY.module_description.max} 字` },
                  kind: { type: 'string', enum: ['backbone', 'module', 'loss', 'training_strategy', 'dataset', 'protocol', 'other'] },
                  expected_advantage: { type: 'string', description: '这个模块凭什么比现有做法好' },
                },
                required: ['name', 'role', 'description', 'kind', 'expected_advantage'],
              },
            },
            innovation: { type: 'string', description: '创新点汇总（给人读的）' },
            innovations: {
              type: 'array',
              description: '逐条创新点（结构化，便于归档）',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  statement: { type: 'string', description: `${GRANULARITY.innovation.min}–${GRANULARITY.innovation.max} 字` },
                  kind: { type: 'string', enum: ['new_method', 'new_framework', 'new_loss', 'new_dataset', 'new_benchmark', 'new_insight', 'other'] },
                  related_module: { type: 'string', description: '对应哪个模块（模块名）' },
                },
                required: ['statement', 'kind'],
              },
            },
            evaluation: {
              type: 'object',
              additionalProperties: false,
              description: '预期评测设定（评测专家要逐项比对库里有没有覆盖过）',
              properties: {
                benchmarks: { type: 'array', items: { type: 'string' } },
                metrics: { type: 'array', items: { type: 'string' } },
                protocols: { type: 'array', items: { type: 'string' } },
                baselines: { type: 'array', items: { type: 'string' } },
              },
              required: ['benchmarks', 'metrics', 'protocols', 'baselines'],
            },
            expected_gain: { type: 'string', description: '预期提升（尽量可量化）' },
            risks: { type: 'array', items: { type: 'string' }, description: '这条 idea 最可能怎么失败（2–4 条）' },
            baselines: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'statement', 'problem', 'method', 'method_modules', 'innovation', 'baselines'],
        },
      },
    },
    required: ['ideas'],
  }
}

/** 宽松形状校验：把 Generator 的结构化结果收敛成 IdeaCandidate。 */
export function coerceIdeas(value: unknown, lens: string, generatedBy: string): Omit<IdeaCandidate, 'idea_id'>[] {
  const list = (value as { ideas?: unknown })?.ideas
  if (!Array.isArray(list)) return []
  const out: Omit<IdeaCandidate, 'idea_id'>[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const statement = typeof record.statement === 'string' ? record.statement.trim() : ''
    if (statement === '') continue
    out.push({
      statement,
      problem: typeof record.problem === 'string' ? record.problem : '',
      method: typeof record.method === 'string' ? record.method : '',
      innovation: typeof record.innovation === 'string' ? record.innovation : '',
      baselines: Array.isArray(record.baselines) ? record.baselines.map(String) : [],
      lens,
      generated_by: generatedBy,
    })
  }
  return out
}

export function apply(ctx: Context): void {
  const ideaScore: IdeaScoreService = ctx.ideaScore
  const kb = ctx.kb
  const toolsRuntime = ctx.tools
  const subagents = ctx.get('subagents') as SubagentLike | undefined

  // ── cvagent_idea_generate ────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: IDEA_TOOLS.generate,
    description:
      '提出候选 idea（**必须经 LLM 生成**）：并发委派 N 个视角的 Generator 子代理，'
      + '每个视角只看知识库（问题/方法/创新/失败库），产出若干候选；本工具把结果合并去重。'
      + '视角缺省取自问题库（每个问题卡 = 一个视角）；每个视角的产出条数与空视角情况都会回传。',
    parameters: {
      sub_domain: { type: 'string', description: '本项目细分领域的一句话描述（来自与用户的对话），会写进子代理上下文' },
      lenses: { type: 'array', items: { type: 'string' }, description: '显式指定视角（缺省从问题库取）' },
      max_lenses: { type: 'integer', description: '最多几个视角（默认 6）；每个视角一次委派，成本随之线性增长' },
      ideas_per_lens: { type: 'integer', description: '每个视角产出几条候选（默认 3）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lens_count: { type: 'integer', required: true },
          candidate_count: { type: 'integer', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                idea_id: { type: 'string', required: true },
                statement: { type: 'string', required: true },
                problem: { type: 'string', required: true },
                method: { type: 'string', required: true },
                innovation: { type: 'string', required: true },
                baselines: { type: 'array', required: true, items: { type: 'string' } },
                lens: { type: 'string', required: true },
                generated_by: { type: 'string', required: true },
              },
            },
          },
          per_lens: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                lens: { type: 'string', required: true },
                produced: { type: 'integer', required: true, description: '该视角**新增**的候选数（去重后）' },
                status: { type: 'string', required: true, description: 'ok / duplicate / empty / error（空视角与全是重复都是信息）' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派 Generator 子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const maxLenses = args.max_lenses === undefined ? 6 : Number(args.max_lenses)
      const ideasPerLens = args.ideas_per_lens === undefined ? 3 : Number(args.ideas_per_lens)
      const explicit = Array.isArray(args.lenses) ? args.lenses.map(String) : []
      const lenses = explicit.length > 0
        ? explicit.slice(0, maxLenses)
        : (kb.searchEntries({ store: 'problems', limit: maxLenses }) as { statement: string }[]).map((entry) => entry.statement)

      const perLens: { lens: string; produced: number; status: string; note?: string }[] = []
      const merged: Omit<IdeaCandidate, 'idea_id'>[] = []
      const seen = new Set<string>()

      for (const lens of lenses) {
        const prompt = [
          options(args.sub_domain),
          `【你的视角】${lens}`,
          `请基于该视角提出 ${ideasPerLens} 条候选 idea。先用 cvagent_kb_search 查看：`,
          '- 该问题下的 methods（已有哪些做法）与 **modules（已有哪些模块）**——避免重复；',
          '- failures（失败方法库）——避免已被否定的做法；',
          `然后用 cvagent_kb_summary 确认库的规模。最后按 outputSchema 输出。`,
          '',
          '【粒度要求】idea 会被拿去和论文库逐字段比对，**太短就比不了**，所以每个字段都要写足：',
          renderGranularityPrompt(['problem', 'method', 'module_description', 'innovation']),
          '其中 `method_modules` 必须把方法拆成 3–6 个模块（每个模块要有名字、在整体里的作用、',
          '以及"输入是什么/做了什么/起什么作用"的一段描述）——它是撞车比对的**对齐单元**。',
        ].filter((line) => line !== '').join('\n')

        let produced = 0
        let status = 'ok'
        let note: string | undefined
        try {
          const run = await subagents.start('spawn', {
            signal: exec.signal,
            parent: exec.agent,
            label: `generator:${lens.slice(0, 40)}`,
            prompt: [{ type: 'text', text: prompt }],
            toolFilter: GENERATOR_TOOL_FILTER,
            persona: GENERATOR_PERSONA,
            outputSchema: ideaOutputSchema(),
            maxDepth: SUBAGENT_MAX_DEPTH,
          })
          try {
            const result = await run.result
            if (result.structured === undefined) {
              status = 'error'
              note = `未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`
            } else {
              const candidates = coerceIdeas(result.structured, lens, `generator:${lens.slice(0, 40)}`)
              for (const candidate of candidates) {
                const key = normalizeTitle(candidate.statement)
                if (key === '' || seen.has(key)) continue
                seen.add(key)
                merged.push(candidate)
                produced += 1
              }
              // 三种情况必须区分（"空视角"是信息，"全是重复"是另一种信息）：
              // raw=0 → 该视角确实想不出方向；raw>0 且 produced=0 → 想出的都被别的视角说过了
              if (candidates.length === 0) {
                status = 'empty'
                note = '该视角没有产出（可能已被做透，或子代理判定无可行方向）'
              } else if (produced === 0) {
                status = 'duplicate'
                note = `该视角产出 ${candidates.length} 条，但均与其它视角重复（已合并）`
              }
            }
          } finally {
            await run.dispose()
          }
        } catch (error) {
          status = 'error'
          note = (error as Error).message
        }
        perLens.push({ lens, produced, status, ...(note === undefined ? {} : { note }) })
      }

      const candidates = merged.map((candidate, index) => ({
        idea_id: `IDEA-${index + 1}`,
        statement: candidate.statement,
        problem: candidate.problem,
        method: candidate.method,
        innovation: candidate.innovation,
        // 工具输出的 schema 声明的是可变数组与必填字符串；core 的 IdeaCandidate 里
        // baselines 是 readonly、lens/generated_by 可选（契约如此），这里落定成输出形态
        baselines: [...candidate.baselines],
        lens: candidate.lens ?? '',
        generated_by: candidate.generated_by ?? '',
      }))
      return { lens_count: lenses.length, candidate_count: candidates.length, candidates, per_lens: perLens }
    },
  }))

  // ── cvagent_idea_score ───────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: IDEA_TOOLS.score,
    description:
      '给一条候选 idea 打分（确定性召回 + 三专家面板 + 确定性聚合）。'
      + '先把 idea 与三库/失败库比对（确定性、三轴召回、不给相似度数字），若相似度落在边界带则返回 status=needs_external_evidence，'
      + '由你（主 Agent）用 mcp__asta__* 检索后带 external_evidence 再次调用；'
      + '随后并行委派三位专家（方法/评测/领域）各自判**模块级对齐**并给四维分，分歧触发一轮讨论，'
      + '最终分数由系统中位数聚合，报告自包含可复算。',
    parameters: {
      statement: { type: 'string', required: true, description: 'idea 一句话陈述' },
      problem: { type: 'string', required: true, description: '问题侧描述（用于问题库检索）' },
      method: { type: 'string', required: true, description: '方法侧描述（用于方法库检索）' },
      innovation: { type: 'string', description: '预期创新点' },
      method_modules: {
        type: 'array',
        description: 'idea 的方法模块（整合设计 §6.2）：专家按模块判对齐；缺省由 problem/method 合成一个模块',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            role: { type: 'string', required: true },
            description: { type: 'string', required: true },
            kind: { type: 'string', required: true, description: 'module / loss / protocol / dataset / other' },
            expected_advantage: { type: 'string' },
          },
        },
      },
      baselines: { type: 'array', items: { type: 'string' }, description: '建议 baseline 论文 ID' },
      idea_id: { type: 'string', description: '候选 ID（generate 给出的 IDEA-n）；缺省按 statement 生成' },
      external_evidence: {
        type: 'string',
        description: '外扩检索结果 JSON 文本：[{"ref_id":"<paper_id>","statement":"标题/摘要要点","similarity":0.12}]',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, description: 'scored / needs_external_evidence' },
          idea_id: { type: 'string', required: true },
          pack_ref: { type: 'string', required: true },
          pack_frozen: { type: 'boolean', required: true, description: '权重是否来自**已冻结**的 pack' },
          retrieval_mode: { type: 'string', required: true, description: '召回与证据相似度的口径（当前恒为 keyword_only）' },
          escalation_reason: { type: 'string', description: 'status=needs_external_evidence 时说明为何要外扩' },
          panel_context: { type: 'string', description: '交给三专家面板的证据上下文（可直接作为委派 prompt）' },
          total: { type: 'integer' },
          dimensions: { type: 'object', additionalProperties: true, description: '四维分（三位专家中位数聚合）' },
          suggestion: { type: 'string' },
          risk_level: { type: 'string' },
          module_alignment: {
            type: 'array',
            description: 'idea 模块级对齐结论（跨专家多数票）；dissent 是少数派意见',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                idea_module: { type: 'string', required: true },
                status: { type: 'string', required: true, description: 'new / partial / known' },
                dissent: { type: 'array', items: { type: 'string' }, required: true, description: '少数派意见（"专家=判定"）' },
              },
            },
          },
          experts: {
            type: 'array',
            description: '每位专家的四维分与理由（审计：看得出中位数从哪几个数来）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                expert: { type: 'string', required: true },
                novelty_problem: { type: 'integer', required: true },
                novelty_method: { type: 'integer', required: true },
                novelty_combo: { type: 'integer', required: true },
                feasibility: { type: 'integer', required: true },
                rationale: { type: 'string', required: true },
              },
            },
          },
          panel_notes: {
            type: 'array',
            items: { type: 'string' },
            description: '面板自洽性问题：判定与分数矛盾（conflicts）、给了分却没引用（unsupported）、未收敛的分歧',
          },
          recall_mode: {
            type: 'string',
            required: true,
            description: '候选论文怎么找出来的：llm_screen（子代理读了全库后挑的）/ keyword（关键词兜底）。'
              + 'keyword 模式下"没找到撞车"的可信度更低——关键词会漏掉换词的情况。',
          },
          recall_notes: {
            type: 'array',
            items: { type: 'string' },
            description: '粗筛的问题：模型报了库里没有的编号、某些模块一条候选都没给、或粗筛失败退回了关键词',
          },
          external_gate: {
            type: 'string',
            required: true,
            description: '外扩闸门是谁做的判断：llm（粗筛子代理读全库后判的）/ keyword（旧的关键词边界带兜底）',
          },
          suggested_queries: {
            type: 'array',
            items: { type: 'string' },
            description: 'status=needs_external_evidence 时的外部检索建议词（可直接拿去检索，中英文都有）',
          },
          escalated_external: { type: 'boolean', description: '本次是否用了外扩（Asta）证据；仅 status=scored 时有意义' },
          report_consistent: { type: 'boolean', description: '报告自洽性（总分可由权重快照复算）' },
          failure_blocked_by: { type: 'array', items: { type: 'string' }, description: '失败库中"条件仍成立"的条目 ID' },
          failure_waivers: { type: 'array', items: { type: 'string' }, description: '判定"值得再试"的失败条目 ID' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派专家子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const modules = coerceIdeaModules(args.method_modules)
      // `exactOptionalPropertyTypes` 下条件展开会把可选属性推成 `T | undefined`，所以先建
      // 可变对象、再按需赋 `method_modules`（无模块时不写这个键，而不是写 undefined）。
      const draft: { -readonly [K in keyof IdeaCandidate]: IdeaCandidate[K] } = {
        idea_id: args.idea_id === undefined ? `IDEA-${normalizeTitle(String(args.statement)).slice(0, 12) || 'adhoc'}` : String(args.idea_id),
        statement: String(args.statement),
        problem: String(args.problem),
        method: String(args.method),
        innovation: args.innovation === undefined ? '' : String(args.innovation),
        baselines: (args.baselines ?? []).map(String),
      }
      if (modules !== undefined) draft.method_modules = modules
      const idea: IdeaCandidate = draft

      const packInfo = await ideaScore.packInfo()
      const panelConfig = await ideaScore.panelConfig()
      const external = parseExternalEvidence(args.external_evidence)

      // ── 粗筛：让一个子代理读「问题库 + 模块清单」全文 ──────────────────────
      // 两件事一起做：挑出相关条目、判断本地库够不够判断撞车。
      // 这是用户 2026-09-18 定的方向：库小到能整读（8493 字），就不该用关键词去猜——
      // 关键词会把"用词不同但意思相同"的论文主动扔掉，而那正是最该抓的撞车。
      const screening = await screenCandidates(subagents, {
        ideaId: idea.idea_id,
        idea,
        kb: await ideaScore.screenKb(),
        agent: exec.agent,
        signal: exec.signal,
      })
      const screenFailed = 'error' in screening

      // ── 外扩闸门：要不要花钱去外面的学术库查一圈 ──────────────────────────
      //
      // 优先用粗筛子代理的判断——它读过全库，是这条链路上唯一有资格回答"库够不够"的东西。
      // 旧的关键词边界带判据（`derive()` 的 [0.10, 0.30)）降级为**兜底**：粗筛失败、
      // 或者模型没回答这个问题时用它。能力不丢，但不再让一个没有语义的数字当主判据。
      //
      // 为什么必须换掉旧判据：同义改写的字符相似度只有 0.0039，**落在 0.10 以下**，
      // 按旧规则不触发外扩——最该去外面查的那种情况恰恰不查。
      let gate: { source: 'llm' | 'keyword'; needsExternal: boolean; reason: string; queries: readonly string[] }
      if (!screenFailed && screening.coverage.verdict !== 'unknown') {
        gate = {
          source: 'llm',
          needsExternal: screening.coverage.verdict === 'insufficient',
          reason: screening.coverage.reason,
          queries: screening.coverage.suggested_queries,
        }
      } else {
        const why = screenFailed
          ? `粗筛未成功（${screening.error}）`
          : '粗筛未回答"本地库够不够"'
        const local = await ideaScore.retrieve(idea)
        const derived = await ideaScore.derive(idea, mergeEvidence(local, external))
        gate = {
          source: 'keyword',
          needsExternal: derived.needs_external,
          reason: derived.external_reason === '' ? '' : `${why}，已退回关键词判据：${derived.external_reason}`,
          queries: [],
        }
      }

      // 需要外扩且还没有外扩证据 → 交回主 Agent 去跑 Asta（工具不能自己调别的工具）
      if (gate.needsExternal && external.length === 0) {
        // 预览用粗筛的真实候选（粗筛失败时退回关键词，报告里如实标）
        const preview = await ideaScore.collide(idea, screenFailed ? undefined : screening)
        return {
          status: 'needs_external_evidence',
          idea_id: idea.idea_id,
          pack_ref: `${packInfo.pack_id}@${packInfo.version}`,
          pack_frozen: packInfo.frozen,
          retrieval_mode: packInfo.retrieval_mode,
          recall_mode: preview.recall_mode,
          recall_notes: recallNotes(preview, screenFailed ? screening.error : undefined),
          external_gate: gate.source,
          escalation_reason: gate.reason === '' ? '本地库判据不充分，建议外扩检索' : gate.reason,
          suggested_queries: [...gate.queries],
          panel_context: renderCollisionContext(preview, idea),
        }
      }

      const collision = await ideaScore.collide(idea, screenFailed ? undefined : screening)
      const context = renderCollisionContext(collision, idea, external)

      const panel = await runExpertPanel(subagents, {
        ideaId: idea.idea_id,
        context,
        weights: panelConfig.weights,
        bands: panelConfig.bands,
        agent: exec.agent,
        signal: exec.signal,
      })

      const report = await ideaScore.reportFromPanel({
        idea,
        panel,
        collision,
        retrievalMode: packInfo.retrieval_mode,
        escalatedExternal: external.length > 0,
      })
      const consistency = ideaScore.verify(report)

      return {
        status: 'scored',
        idea_id: report.idea_id,
        pack_ref: report.pack_ref,
        pack_frozen: report.pack_frozen,
        retrieval_mode: report.retrieval_mode,
        total: report.total,
        dimensions: { ...report.dimensions },
        suggestion: report.suggestion,
        risk_level: report.risk_level,
        module_alignment: (report.panel?.module_alignment ?? []).map((item) => ({
          idea_module: item.idea_module,
          status: item.status,
          dissent: item.dissent.map((entry) => `${entry.expert}=${entry.status}`),
        })),
        experts: report.panel === undefined ? [] : report.panel.experts.map((verdict) => ({
          expert: verdict.expert,
          novelty_problem: verdict.dimension_scores.novelty_problem,
          novelty_method: verdict.dimension_scores.novelty_method,
          novelty_combo: verdict.dimension_scores.novelty_combo,
          feasibility: verdict.dimension_scores.feasibility,
          rationale: verdict.rationale,
        })),
        panel_notes: panelNotes(report.panel),
        recall_mode: collision.recall_mode,
        recall_notes: recallNotes(collision, screenFailed ? screening.error : undefined),
        external_gate: gate.source,
        escalated_external: report.escalated_external ?? false,
        report_consistent: consistency.consistent,
        failure_blocked_by: [...(report.failure_review?.blocked_by ?? [])],
        failure_waivers: [...(report.failure_review?.waivers.map((waiver) => waiver.ref_id) ?? [])],
      }
    },
  }))
}

/**
 * 把外扩证据并进本地证据集合。
 *
 * 证据集合是**不可变**的（`RetrievedEvidence` 的字段是 readonly）：外扩证据用新数组
 * 合并，而不是往既有数组里 push——否则同一份证据对象会被两次打分共享并互相污染。
 */
function mergeEvidence(
  local: Awaited<ReturnType<IdeaScoreService['retrieve']>>,
  external: readonly { ref_id: string; statement: string; similarity?: number }[],
): Awaited<ReturnType<IdeaScoreService['retrieve']>> {
  if (external.length === 0) return local
  return {
    ...local,
    hits: [
      ...local.hits,
      ...external.map((item) => ({
        ref_id: item.ref_id,
        source: 'papers' as const,
        statement: item.statement,
        ...(item.similarity === undefined ? {} : { backend_score: item.similarity }),
        external: true,
      })),
    ],
  }
}

/**
 * 粗筛的问题清单（工具层直接汇报）。
 *
 * 三类都要报给主 Agent，不能悄悄留在报告里：
 * - **模型编了编号**：它报了库里没有的条目——这是"模型在编"的直接证据；
 * - **某个模块一条候选都没给**：可能是真新，也可能是它没看懂，要人分辨；
 * - **粗筛失败退回关键词**：结论强度随之下降，必须说。
 */
export function recallNotes(report: CollisionReport, screenError: string | undefined): string[] {
  const notes: string[] = []
  if (screenError !== undefined) {
    notes.push(`粗筛未成功（${screenError}），已退回关键词召回——换词同义的撞车可能被漏掉`)
  }
  for (const dropped of report.screened_dropped) {
    notes.push(`粗筛报了库里不存在的编号：${dropped.kind === 'problem' ? '问题' : '模块'} ${dropped.id}（已丢弃）`)
  }
  for (const module of report.unmatched_idea_modules) {
    notes.push(`粗筛对模块「${module}」一条候选都没给——可能是真新，也可能是措辞差异导致它没认出来`)
  }
  return notes
}

function options(subDomain: unknown): string {
  return subDomain === undefined || String(subDomain).trim() === ''
    ? ''
    : `【项目细分领域】${String(subDomain)}`
}

const MODULE_KINDS: readonly MethodModuleKind[] = ['module', 'loss', 'protocol', 'dataset', 'other']

/**
 * 入参里的 idea 模块 → `MethodModule[]`。
 *
 * idea 的模块是**打分单元**（§6.2 "方法以模块为对齐单位"）：没有模块，三位专家就只能
 * 对整段方法描述给一个笼统印象分，模块级对齐与"哪一块撞了"都无从谈起。
 *
 * 缺省合成一个模块（用 method 描述），而不是返回 `undefined`——专家拿到的对齐任务里
 * 必须有模块，否则 `module_verdicts` 会是空的，面板就退化成旧的"整条打分"。
 */
export function coerceIdeaModules(raw: unknown): IdeaModule[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const modules: IdeaModule[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const moduleName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (moduleName === '') continue
    const kind = MODULE_KINDS.find((candidate) => candidate === entry.kind)
    modules.push({
      name: moduleName,
      role: typeof entry.role === 'string' ? entry.role : '',
      description: typeof entry.description === 'string' ? entry.description : '',
      kind: kind ?? 'module',
      // `IdeaModule.expected_advantage` 是必填（专家要靠它判"预期优势是否已有"）：缺省空串
      expected_advantage: typeof entry.expected_advantage === 'string' ? entry.expected_advantage : '',
    })
  }
  return modules.length === 0 ? undefined : modules
}

/**
 * 面板自洽性问题（工具层直接汇报）。
 *
 * 三类都要报给主 Agent，而不是让它们悄悄留在报告里：
 * `conflicts`（判了 known 却给高分）、`unsupported`（给了判定却没引用）、
 * 未收敛的分歧——这三类正是"分数看起来没问题但其实不可信"的来源。
 */
export function panelNotes(panel: PanelAudit | undefined): string[] {
  if (panel === undefined) return []
  const notes: string[] = [...panel.conflicts, ...panel.unsupported]
  for (const disagreement of panel.remaining) {
    const where = disagreement.target.replace(/^(dimension|module):/, '')
    notes.push(`未收敛的分歧（${disagreement.kind === 'dimension' ? '维度' : '模块'} ${where}）：${disagreement.positions.map((position) => `${position.expert}=${position.value}`).join('，')}`)
  }
  for (const failure of panel.failed) notes.push(`专家 ${failure.expert} 未参与最终聚合：${failure.error}`)
  return notes
}

function parseExternalEvidence(raw: unknown): { ref_id: string; statement: string; similarity?: number }[] {
  if (raw === undefined || String(raw).trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw))
  } catch (error) {
    throw new Error(`external_evidence 不是合法 JSON：${(error as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('external_evidence 必须是数组')
  return parsed
    .map((item) => {
      const record = (item ?? {}) as Record<string, unknown>
      if (typeof record.ref_id !== 'string' || typeof record.statement !== 'string') return undefined
      return {
        ref_id: record.ref_id,
        statement: record.statement,
        ...(typeof record.similarity === 'number' ? { similarity: record.similarity } : {}),
      }
    })
    .filter((item): item is { ref_id: string; statement: string; similarity?: number } => item !== undefined)
}
