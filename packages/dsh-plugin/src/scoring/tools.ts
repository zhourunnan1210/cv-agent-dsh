/**
 * Idea 族工具（P3-3b）：`cvagent_idea_generate` 与 `cvagent_idea_score`。
 *
 * 分工（勘误 §11.2，用户 2026-09-17 裁定）：
 * - **生成**：N 个不同视角的 Generator 子代理并发产出 → 主 Agent 侧合并去重（视角标记保留）；
 * - **打分**：确定性召回（`ideaScore` 服务）→ 边界带命中则**外扩 Asta**（由主 Agent 执行检索后回传）
 *   → **裁判子代理**逐条判定（与 Generator 无共享上下文）→ 确定性聚合 → 失败库复查结论。
 *
 * 本行是 `ideaScore` 与 `kb` 的消费者，必须与它们同处一个 isolate group（§4.4.1）。
 *
 * @module cv-agent-dsh/idea-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import { GRANULARITY, normalizeTitle, renderGranularityPrompt, type IdeaCandidate } from '@cv-research/core'

import { IDEA_TOOLS } from '../tools/names.js'
import type { IdeaScoreService } from './service.js'
import { SUBAGENT_MAX_DEPTH } from '../subagent.js'
import type { SubagentLike } from '../subagent.js'

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

/**
 * 裁判子代理的工具面。
 *
 * 理想的裁判不需要任何工具（证据包全在 prompt 里）。这里给 `read` 是为了
 * 允许"受限追问"（§11.8 约束 5）：裁判若认为某条证据的片段不足以判断，
 * 可以读我们随包给它的小文件（如 pack 的枚举定义），而不是去检索整个库。
 * **不给检索工具**——否则它可能自行扩大证据集合，破坏"输入由确定性检索决定"（约束 1）。
 */
export const JUDGE_TOOL_FILTER = { allow: ['read'] } as const

/** Generator 角色 persona（§16.2 五段式的角色段）。 */
export const GENERATOR_PERSONA = [
  '你是 cv-research 的 Idea Generator 子代理：只负责在**给定的一个视角**内提出候选研究 idea。',
  '你手上只有知识库只读检索工具（cvagent_kb_search / cvagent_kb_summary）：',
  '先用它们查看该视角下的问题卡、方法卡、创新卡与失败方法库，再提出候选。',
  '每个候选要写清：一句话陈述、面向的问题、拟采用的方法、预期创新点、1–3 篇建议 baseline 论文 ID。',
  '禁止提出已被失败方法库明确否定的做法；若你认为某条失败的条件已变，必须在该候选里说明理由。',
  '只输出结构化结果，不要输出自由文本。',
].join(' ')

/** 裁判角色 persona（§11.8）。 */
export const JUDGE_PERSONA = [
  '你是 cv-research 的 Idea Judge 子代理：只做**撞车判定**，不给总分。',
  '你会收到一条候选 idea 与一批证据（三库条目、失败方法库条目，可能还有外部检索结果）。',
  '对**每一条**证据判定：collision（实质撞车——已有工作做过同一件事；或失败条件仍然成立）',
  '或 superficial（只是表面相似——用词相近但任务/机制不同；或失败条件已变）。',
  '必须给出理由，理由要引用具体条目 ID 与差异点。判定 collision 时尤其要克制：',
  '只有当你确信"同一问题 + 同一方法"已被覆盖，才判 collision；只是主题相关一律 superficial。',
  '另外给一个 0–100 的 feasibility（基于建议 baseline 的实验可行性）与一段总述理由。',
  '不要给出四维分值，也不要计算总分——分值由系统从你的判定算出。',
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

/** 裁判判定的 outputSchema。 */
export function judgeOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref_id: { type: 'string' },
            verdict: { type: 'string', enum: ['collision', 'superficial'] },
            reason: { type: 'string' },
          },
          required: ['ref_id', 'verdict', 'reason'],
        },
      },
      feasibility: { type: 'integer' },
      rationale: { type: 'string' },
    },
    required: ['verdicts', 'feasibility', 'rationale'],
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

/** 宽松形状校验：裁判判定。 */
export function coerceVerdicts(value: unknown): { verdicts: { ref_id: string; verdict: 'collision' | 'superficial'; reason: string }[]; feasibility?: number; rationale: string } {
  const record = (value ?? {}) as Record<string, unknown>
  const raw = Array.isArray(record.verdicts) ? record.verdicts : []
  const verdicts = raw
    .map((item) => {
      const entry = item as Record<string, unknown>
      const refId = typeof entry.ref_id === 'string' ? entry.ref_id : ''
      const verdict = entry.verdict === 'collision' ? 'collision' as const : entry.verdict === 'superficial' ? 'superficial' as const : undefined
      if (refId === '' || verdict === undefined) return undefined
      return { ref_id: refId, verdict, reason: typeof entry.reason === 'string' ? entry.reason : '' }
    })
    .filter((item): item is { ref_id: string; verdict: 'collision' | 'superficial'; reason: string } => item !== undefined)
  return {
    verdicts,
    ...(typeof record.feasibility === 'number' ? { feasibility: record.feasibility } : {}),
    rationale: typeof record.rationale === 'string' ? record.rationale : '',
  }
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
      '给一条候选 idea 打分（确定性召回 + LLM 裁判 + 确定性聚合）。'
      + '先把 idea 与三库/失败库比对（确定性），若相似度落在边界带则返回 status=needs_external_evidence，'
      + '由你（主 Agent）用 mcp__asta__* 检索后带 external_evidence 再次调用；'
      + '随后委派裁判子代理逐条判定撞车，分数由系统从判定与证据算出，报告自包含可复算。',
    parameters: {
      statement: { type: 'string', required: true, description: 'idea 一句话陈述' },
      problem: { type: 'string', required: true, description: '问题侧描述（用于问题库检索）' },
      method: { type: 'string', required: true, description: '方法侧描述（用于方法库检索）' },
      innovation: { type: 'string', description: '预期创新点' },
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
          retrieval_mode: { type: 'string', required: true },
          escalation_reason: { type: 'string', description: 'status=needs_external_evidence 时说明为何要外扩' },
          judge_payload: { type: 'string', description: '交给裁判子代理的证据包（可直接作为委派 prompt）' },
          total: { type: 'integer' },
          dimensions: { type: 'object', additionalProperties: true, description: '四维分值（由判定与证据算出）' },
          suggestion: { type: 'string' },
          risk_level: { type: 'string' },
          escalated_external: { type: 'boolean', description: '本次是否用了外扩（Asta）证据；仅 status=scored 时有意义' },
          report_consistent: { type: 'boolean', description: '报告自洽性（总分可由权重快照复算）' },
          failure_blocked_by: { type: 'array', items: { type: 'string' }, description: '失败库中"条件仍成立"的条目 ID' },
          failure_waivers: { type: 'array', items: { type: 'string' }, description: '判定"值得再试"的失败条目 ID' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派裁判子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const idea: IdeaCandidate = {
        idea_id: args.idea_id === undefined ? `IDEA-${normalizeTitle(String(args.statement)).slice(0, 12) || 'adhoc'}` : String(args.idea_id),
        statement: String(args.statement),
        problem: String(args.problem),
        method: String(args.method),
        innovation: args.innovation === undefined ? '' : String(args.innovation),
        baselines: (args.baselines ?? []).map(String),
      }

      const packInfo = await ideaScore.packInfo()
      const local = await ideaScore.retrieve(idea)
      const external = parseExternalEvidence(args.external_evidence)
      // 证据集合是**不可变**的（RetrievedEvidence 的字段是 readonly）：外扩证据用新数组合并，
      // 而不是往既有数组里 push——否则同一份证据对象会被两次打分共享并互相污染。
      const evidence = external.length === 0
        ? local
        : {
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
      const derived = await ideaScore.derive(idea, evidence)

      // 边界带命中且尚无外扩证据 → 交回主 Agent 去跑 Asta（工具不能自己调别的工具）
      if (derived.needs_external && external.length === 0) {
        return {
          status: 'needs_external_evidence',
          idea_id: idea.idea_id,
          pack_ref: `${packInfo.pack_id}@${packInfo.version}`,
          pack_frozen: packInfo.frozen,
          retrieval_mode: packInfo.retrieval_mode,
          escalation_reason: derived.external_reason,
          judge_payload: ideaScore.buildJudgePayload({ idea, derived, evidence }),
        }
      }

      const payload = ideaScore.buildJudgePayload({ idea, derived, evidence, external })
      const run = await subagents.start('spawn', {
        signal: exec.signal,
        parent: exec.agent,
        label: `judge:${idea.idea_id}`,
        prompt: [{ type: 'text', text: payload }],
        toolFilter: JUDGE_TOOL_FILTER,
        persona: JUDGE_PERSONA,
        outputSchema: judgeOutputSchema(),
        maxDepth: SUBAGENT_MAX_DEPTH,
      })

      let judged
      try {
        const result = await run.result
        if (result.structured === undefined) {
          throw new Error(`裁判子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
        }
        judged = coerceVerdicts(result.structured)
      } finally {
        await run.dispose()
      }

      const report = await ideaScore.aggregate({
        idea,
        derived,
        evidence,
        judge: {
          verdicts: judged.verdicts,
          ...(judged.feasibility === undefined ? {} : { feasibility: judged.feasibility }),
          rationale: judged.rationale,
          judged_by: `judge:${idea.idea_id}`,
          judged_at: new Date().toISOString(),
        },
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
        escalated_external: report.escalated_external ?? false,
        report_consistent: consistency.consistent,
        failure_blocked_by: [...(report.failure_review?.blocked_by ?? [])],
        failure_waivers: [...(report.failure_review?.waivers.map((waiver) => waiver.ref_id) ?? [])],
      }
    },
  }))
}

function options(subDomain: unknown): string {
  return subDomain === undefined || String(subDomain).trim() === ''
    ? ''
    : `【项目细分领域】${String(subDomain)}`
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
