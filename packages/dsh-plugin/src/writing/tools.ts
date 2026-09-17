/**
 * 写作族工具（P4-1）：`cvagent_write_draft` —— **上下文组装 + 委派**，不自己写引擎。
 *
 * ## 设计立场（用户 2026-09-17 裁定）
 *
 * 「写作管线，合理组装，按需使用仓库里的工具就行」——本项目**不重造写作引擎**。
 * 仓库里已经有成体系的写作 skill（CCFA 的 `academic-paper` / `ccf-paper-writer`、
 * nature 系列的 `nature-writing` / `nature-polishing` / `nature-citation`、
 * `researchwrite` 等，都在 `.dsh/skills/` 下）。因此本工具只做三件事：
 *
 * 1. **确定性组装上下文**：冻结 pack 的术语与 benchmark 口径、三库相关条目、
 *    实验证据的**文件路径**（不是内容——证据要被读，不能被摘要替代）、写作纪律；
 * 2. **委派 Writer 子代理**，并在 prompt 里**点名要加载哪个 skill**（子代理自己调
 *    `skill({name})` 拿完整指令）；
 * 3. **只回结构化摘要**：草稿路径、字数、引用到的条目 ID、未落实的证据缺口（`todos`）。
 *    正文**不进主 Agent 上下文**（原则四）。
 *
 * ## 为什么证据只给路径
 *
 * 写作的硬规则是「任何数字都能指回产物」（docs/实验归档与组织原则.md §3 规则 1）。
 * 如果把 `RESULTS.md` 的内容摘要后喂给 Writer，它就只能转述我们的摘要——数字的
 * 溯源链断在工具层。给路径 + 强制它 `read`，溯源链才完整（且 `EVIDENCE.md` 里的
 * `runs/<id>/metrics.json#auc` 这种字段级引用也才能被照抄）。
 *
 * @module cv-agent-dsh/write-draft
 */

import { readdir, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import { IDEA_TOOLS } from '../tools/names.js'
import type { KbService } from '../kb/service.js'

export const name = 'cvagent-write-draft'
export const inject = ['kb', 'tools']

/** 插件配置。 */
export interface Config {
  /** 草稿输出目录。 */
  draftsDir?: string
  /** 实验归档目录（读 RESULTS.md / EVIDENCE.md）。 */
  experimentsDir?: string
  /** 写作纪律文档路径（随包指给子代理）。 */
  archivePrinciplePath?: string
  /** 缺省写作 skill。 */
  defaultSkill?: string
  /** 项目私有 skill 根（用于校验 skill 是否存在）。 */
  projectSkillsDir?: string
}

/** 解析默认值（E19：不带 config 的行，默认值必须显式落定）。 */
export function resolveWriteConfig(config: Config | undefined): Required<Config> {
  return {
    draftsDir: config?.draftsDir ?? 'drafts',
    experimentsDir: config?.experimentsDir ?? 'experiments',
    archivePrinciplePath: config?.archivePrinciplePath ?? 'docs/实验归档与组织原则.md',
    defaultSkill: config?.defaultSkill ?? 'academic-paper',
    projectSkillsDir: config?.projectSkillsDir ?? '.dsh/skills',
  }
}

/**
 * Writer 子代理的工具面。
 *
 * 名字必须与真实注册的工具名一致——`restrict()` 遇到未知名字会在**委派时抛错**
 * （E14），所以这里逐个核对过：`read`/`write`/`edit`/`glob`/`grep`（filesystem 两行）、
 * `skill`（加载写作 skill）、`present`（把交付物登记给用户）、以及知识库只读检索。
 *
 * **不给**写库工具：写作阶段不该改知识库（发现文献缺口应回报给 Orchestrator，
 * 由它决定是否补检索）。
 */
export const WRITER_TOOL_FILTER = {
  allow: ['read', 'write', 'edit', 'glob', 'grep', 'skill', 'present', 'cvagent_kb_search', 'cvagent_kb_summary'],
} as const

export const WRITER_PERSONA = [
  '你是 cv-research 的 Writer 子代理：按指定 skill 的指令写出**证据可溯源**的草稿。',
  '硬规则：① 任何数字都必须能在实验归档的 EVIDENCE.md 里找到来源（文件+字段级），',
  '引用时照抄来源路径；② 术语与数据集名必须与领域包（pack）给出的规范写法一致；',
  '③ 没有依据的说法不要写——宁可在文末 `## TODO` 里列成缺口；④ 不要编造引用：',
  '建议的引用只能来自给你的三库条目所附的 paper_id。',
  '你的产物是一个 Markdown 文件；回复只给结构化摘要，不要把正文贴回来。',
].join(' ')

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

interface SubagentLike {
  start(name: string, request: unknown): Promise<{
    result: Promise<{ structured?: unknown; stopReason: string; diagnostic?: string }>
    dispose(): Promise<void>
  }>
}

/** Writer 的 outputSchema（摘要形态：正文不进父上下文）。 */
export function writerOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      draft_path: { type: 'string' },
      word_count: { type: 'integer' },
      sections: { type: 'array', items: { type: 'string' }, description: '写出的小节标题列表' },
      cited_entry_ids: { type: 'array', items: { type: 'string' }, description: '引用到的三库条目 ID' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: '引用到的证据来源（文件路径或 paper:<id>）' },
      skill_used: { type: 'string' },
      todos: { type: 'array', items: { type: 'string' }, description: '证据/引用缺口（不许靠编造填补）' },
    },
    required: ['draft_path', 'word_count', 'sections', 'cited_entry_ids', 'evidence_refs', 'skill_used', 'todos'],
  }
}

/** 发现写作类 skill（数据驱动：从 skill 根目录读，不把名字硬编码在代码里）。 */
export async function listWritingSkills(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(resolve(dir), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && /paper|writ|polish|citation|research/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 扫描实验归档：返回有 RESULTS.md 的实验及其证据文件路径。 */
export async function listExperiments(dir: string): Promise<{ id: string; results: string; evidence: string | null }[]> {
  const root = resolve(dir)
  if (!existsSync(root)) return []
  const out: { id: string; results: string; evidence: string | null }[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    const results = join(dir, entry.name, 'RESULTS.md')
    if (!existsSync(resolve(results))) continue
    const evidence = join(dir, entry.name, 'EVIDENCE.md')
    out.push({ id: entry.name, results, evidence: existsSync(resolve(evidence)) ? evidence : null })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function apply(ctx: Context, config: Config = {}): void {
  const kb: KbService = ctx.kb
  const toolsRuntime = ctx.tools
  const options = resolveWriteConfig(config)
  const subagents = ctx.get('subagents') as SubagentLike | undefined

  toolsRuntime.register(defineTool({
    name: IDEA_TOOLS.writeDraft,
    description:
      '组装写作上下文并委派 Writer 子代理产出草稿（**不重造写作引擎**：'
      + '写作方法由仓库里的写作 skill 提供，子代理会按 prompt 指定的 skill 加载完整指令）。'
      + '组装的上下文：冻结 pack 的术语与 benchmark 口径、相关三库条目、实验证据**文件路径**、写作纪律。'
      + '只回结构化摘要（草稿路径 / 字数 / 引用的条目与证据 / 未落实的缺口），正文不进主上下文。',
    parameters: {
      section: { type: 'string', required: true, description: '要写的小节：full / abstract / introduction / related_work / method / experiments / discussion / conclusion 等' },
      skill_name: { type: 'string', description: `用哪个写作 skill（缺省 ${options.defaultSkill}；可用值见输出里的 available_skills）` },
      topic: { type: 'string', description: '主题一句话（用于从四库检索相关条目；缺省用项目研究范围）' },
      entry_ids: { type: 'array', items: { type: 'string' }, description: '必须引用的三库条目 ID（如 P002/M015/I009）' },
      experiment_ids: { type: 'array', items: { type: 'string' }, description: '要引用的实验 ID（如 E001-xxx）；缺省把已收敛实验都给子代理' },
      output_path: { type: 'string', description: '草稿路径（缺省 drafts/<section>-<时间戳>.md）' },
      extra_instructions: { type: 'string', description: '附加要求（面向哪个会议、页数、语言等）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draft_path: { type: 'string', required: true },
          word_count: { type: 'integer', required: true },
          skill_used: { type: 'string', required: true },
          sections_count: { type: 'integer', required: true },
          cited_entry_count: { type: 'integer', required: true },
          evidence_ref_count: { type: 'integer', required: true },
          todos: { type: 'array', required: true, items: { type: 'string' }, description: 'Writer 回报的证据/引用缺口' },
          packed_context: { type: 'string', required: true, description: '组装进上下文的材料清单（可核对，不含正文）' },
          available_skills: { type: 'array', required: true, items: { type: 'string' }, description: '仓库里可用的写作 skill' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派 Writer 子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const section = String(args.section)
      const requestedSkill = args.skill_name === undefined ? options.defaultSkill : String(args.skill_name)
      const available = await listWritingSkills(options.projectSkillsDir)
      if (available.length > 0 && !available.includes(requestedSkill)) {
        throw new Error(
          `找不到写作 skill「${requestedSkill}」。可用：${available.join('、')}`
          + `（skill 根：${options.projectSkillsDir}；由 CV_PROJECT_SKILLS_DIR 决定）`,
        )
      }

      // ── 1. 组装：pack 口径 ────────────────────────────────────────────────
      const packLines: string[] = []
      try {
        const packs = kb.listDomainPacks()
        const binding = kb.getProjectPackBinding('cv-research-default')
        const target = binding === undefined
          ? packs[packs.length - 1]
          : packs.find((pack) => pack.pack_id === binding.pack_id && pack.version === binding.version)
        if (target !== undefined) {
          const frozen = JSON.parse(await readFile(target.pack_path, 'utf8')) as {
            benchmarks?: { benchmarks?: { name: string }[]; metrics?: string[]; required_protocols?: { name: string }[] }
            lexicon?: { terms?: { canonical: string; aliases: string[] }[] }
          }
          packLines.push(`领域包（已冻结，评审人 ${target.frozen_by}）：${target.pack_id}@${target.version}`)
          packLines.push(`  规范数据集名：${(frozen.benchmarks?.benchmarks ?? []).map((item) => item.name).join('、')}`)
          packLines.push(`  规范指标名：${(frozen.benchmarks?.metrics ?? []).join('、')}`)
          packLines.push(`  必需评测协议：${(frozen.benchmarks?.required_protocols ?? []).map((item) => item.name).join('、')}`)
          packLines.push(`  术语规范（canonical ← 别名，写作时用 canonical）：${(frozen.lexicon?.terms ?? []).slice(0, 15).map((term) => `${term.canonical}←${term.aliases.slice(0, 2).join('/')}`).join('；')}`)
        } else {
          packLines.push('领域包：尚无已冻结版本 → 术语与数据集名以三库条目里的写法为准，并在输出里标明包未冻结。')
        }
      } catch (error) {
        packLines.push(`领域包读取失败（${(error as Error).message}）：写作时以三库条目为准。`)
      }

      /**
       * 检索素材。
       *
       * ⚠️ 没给 `topic` 时**不能拿小节名当检索词**：`section` 是 `method` / `experiments`
       * 这类英文词，而三库陈述是中文（如「跨数据集泛化不足…」），FTS/LIKE 都命中不到——
       * 于是 Writer 拿到空的素材清单，只能凭空写（实测踩到）。缺省改为「每库取前若干条」
       * （确定性、且保证有素材），由 Writer 自己按小节需要挑。
       */
      const topic = args.topic === undefined ? '' : String(args.topic).trim()
      const entryLines: string[] = []
      const seen = new Set<string>()
      for (const entryId of (args.entry_ids ?? []).map(String)) {
        for (const store of ['problems', 'methods', 'innovations', 'failures'] as const) {
          const entry = kb.getEntry(store, entryId)
          if (entry === undefined || seen.has(entry.entry_id)) continue
          seen.add(entry.entry_id)
          entryLines.push(`- ${entry.entry_id} [${store}] ${entry.statement}（来源论文：${entry.source_papers.slice(0, 3).join(', ')}）`)
        }
      }
      const retrieved = topic === ''
        ? [
            ...kb.searchEntries({ store: 'problems', limit: 4 }),
            ...kb.searchEntries({ store: 'methods', limit: 4 }),
            ...kb.searchEntries({ store: 'innovations', limit: 4 }),
            ...kb.searchEntries({ store: 'failures', limit: 3 }),
          ]
        : kb.searchEntries({ query: topic, limit: 12 })
      for (const entry of retrieved) {
        if (seen.has(entry.entry_id)) continue
        seen.add(entry.entry_id)
        entryLines.push(`- ${entry.entry_id} [${entry.store}] ${entry.statement.slice(0, 200)}（来源论文：${entry.source_papers.slice(0, 2).join(', ')}）`)
      }

      // ── 3. 组装：实验证据**路径**（内容由 Writer 自己读——溯源链不能断在工具层）
      const experiments = await listExperiments(options.experimentsDir)
      const requestedExperiments = (args.experiment_ids ?? []).map(String)
      const chosen = requestedExperiments.length === 0
        ? experiments
        : experiments.filter((experiment) => requestedExperiments.includes(experiment.id))
      const evidenceLines = chosen.length === 0
        ? ['（暂无已收敛实验：证据类小节应写成 TODO，不得编造数字）']
        : chosen.map((experiment) => `- ${experiment.id}：结论 ${experiment.results}${experiment.evidence === null ? '（⚠ 缺 EVIDENCE.md）' : `；数字溯源 ${experiment.evidence}`}`)

      const outputPath = args.output_path === undefined
        ? join(options.draftsDir, `${section}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`)
        : String(args.output_path)
      await mkdir(resolve(options.draftsDir), { recursive: true })

      const prompt = [
        `【任务】写出论文的「${section}」小节（Markdown 文件，写到 ${outputPath}）。`,
        `【先加载 skill】调用 skill({ name: "${requestedSkill}" }) 拿到完整写作指令，然后严格按它执行。`,
        '',
        '【领域口径】',
        ...packLines,
        '',
        '【可用的三库条目（引用时写明条目 ID；只允许引用这些 paper_id 作为文献来源）】',
        entryLines.length === 0 ? '（本次没有检索到相关条目：文献引用应写成 TODO 并回报缺口）' : entryLines.join('\n'),
        '',
        '【实验证据（**必须自己 read 这些文件**再引用数字；不要凭印象写）】',
        ...evidenceLines,
        '',
        '【写作纪律】',
        `- 归档原则：${options.archivePrinciplePath}（先读它，尤其 §3 的三条硬规则）`,
        '- 任何数字都要能指回产物：引用时写出处（`runs/<id>/metrics.json#field` 或 `paper:<id>`）。',
        '- 术语用领域包给出的 canonical 写法；数据集名用规范名（如 FF++ / Celeb-DF / DFDC）。',
        '- 不确定或没有依据的内容写进文末 `## TODO`，不要编造、不要用"通常/一般来说"糊过去。',
        args.extra_instructions === undefined ? '' : `【附加要求】${String(args.extra_instructions)}`,
        '',
        '完成后按 outputSchema 回结构化摘要（草稿路径、字数、小节、引用的条目与证据、缺口）。不要贴正文。',
      ].filter((line) => line !== '').join('\n')

      const run = await subagents.start('spawn', {
        parent: exec.agent,
        label: `writer:${section}`,
        prompt: [{ type: 'text', text: prompt }],
        toolFilter: WRITER_TOOL_FILTER,
        persona: WRITER_PERSONA,
        outputSchema: writerOutputSchema(),
        maxDepth: 0,
      })

      let structured: Record<string, unknown>
      try {
        const result = await run.result
        if (result.structured === undefined) {
          throw new Error(`Writer 子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
        }
        structured = result.structured as Record<string, unknown>
      } finally {
        await run.dispose()
      }

      const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
      const draftPath = typeof structured.draft_path === 'string' && structured.draft_path !== '' ? structured.draft_path : outputPath
      const wordCount = typeof structured.word_count === 'number'
        ? structured.word_count
        : (await readFile(resolve(draftPath), 'utf8').catch(() => '')).split(/\s+/).filter((word) => word !== '').length

      return {
        draft_path: draftPath,
        word_count: wordCount,
        skill_used: typeof structured.skill_used === 'string' && structured.skill_used !== '' ? structured.skill_used : requestedSkill,
        sections_count: asArray(structured.sections).length,
        cited_entry_count: asArray(structured.cited_entry_ids).length,
        evidence_ref_count: asArray(structured.evidence_refs).length,
        todos: asArray(structured.todos).map(String),
        packed_context: JSON.stringify({
          pack_lines: packLines.length,
          entries: entryLines.length,
          experiments: chosen.map((experiment) => experiment.id),
          topic,
        }),
        available_skills: available,
      }
    },
  }))
}
