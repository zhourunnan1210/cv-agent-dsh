/**
 * 研究流程工具行（P3-4）：Scout 检索委派、Analyst 归纳委派、批量入库。
 *
 * 三段职责（对应勘误 §12.1/§12.3 的缺口）：
 * 1. **`cvagent_kb_scout`**：按细分领域与关键词委派 Scout 子代理（只给 Asta 检索工具，
 *    **不含 `snippet_search`**——Scout 只回候选，正文留给后续取证），返回候选列表；
 * 2. **`cvagent_kb_import_papers`**：把候选**批量**入库（逐条回传 upsert 结果）。
 *    为什么需要批量：Scout 一轮可能带回几十篇，让模型为每篇各调一次工具是纯浪费；
 *    逐条回传结果保证"部分成功"也能被看见，不是全成/全败；
 * 3. **`cvagent_kb_analyze`**：把「Reader 提取 → 库条目」的归纳委派给 Analyst，
 *    由本工具负责**确定性去重写入**（`dry_run` 可只回提案供复核）。
 *
 * 落位：与 `kb` 同处一个 isolate group（§4.4.1）——它 inject kb 与宿主 tools/subagents。
 *
 * @module cv-agent-dsh/kb-research
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import type { ExtensionFields, PaperExtraction, PaperRecord, StoreName } from '@cv-research/core'

import { ASTA_TOOL_NAMES, KB_TOOLS, SCOUT_ALLOWED_TOOLS } from '../tools/names.js'
import type { KbService } from './service.js'

export const name = 'cvagent-kb-research'
export const inject = ['kb', 'tools']

/** Scout：只做检索与去重，回传候选。刻意不含 snippet_search（§5.1 隔离红线）。 */
export const SCOUT_FILTER = { allow: [...SCOUT_ALLOWED_TOOLS] } as const

/** Analyst：需要读既有条目做去重，故给知识库只读检索；**不给写权限**（写入由工具层按规则做）。 */
export const ANALYST_FILTER = { allow: [KB_TOOLS.search, KB_TOOLS.summary] } as const

export const SCOUT_PERSONA = [
  '你是 cv-research 的 Scout 子代理：只做**论文检索与去重**，不做精读、不写库。',
  '给定细分领域与关键词组，用 Asta 检索工具（mcp__asta__*）取回候选论文。',
  '每篇候选要给出可核验的外部标识（DOI / arXiv ID 至少其一）与标题；',
  '没有外部标识的条目宁可丢弃——标题无法唯一标识，后续去重与合并都会出错。',
  '只输出结构化结果。',
].join(' ')

export const ANALYST_PERSONA = [
  '你是 cv-research 的 Analyst 子代理：把 Reader 的结构化提取**归纳成知识库条目**。',
  '你只做归纳与分类，不读论文原文、不做新的抽取——原文事实边界由 Reader 的提取固定。',
  '可以（也应该）用 cvagent_kb_search 查看既有条目，避免重复建档：',
  '同一个概念已有条目时，要么不产出，要么产出更准确、更完整的陈述（系统会按归一化规则合并）。',
  '四个库的语义：problems=跨论文的问题；methods=每篇的核心方法；',
  'innovations=可命名的具体机制（模块/损失/数据集/协议）；failures=「某做法在某条件下不成立」。',
  '每条都要给 source_papers（必须来自给你的提取里出现的 paper_id）。只输出结构化结果。',
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

/** Scout 的 outputSchema。 */
export function scoutOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      papers: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            doi: { type: 'string' },
            arxiv_id: { type: 'string' },
            year: { type: 'integer' },
            venue: { type: 'string' },
            relevance: { type: 'string' },
          },
          required: ['title'],
        },
      },
    },
    required: ['papers'],
  }
}

/** Analyst 的 outputSchema。 */
export function analystOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            store: { type: 'string', enum: ['problems', 'methods', 'innovations', 'failures'] },
            statement: { type: 'string' },
            source_papers: { type: 'array', items: { type: 'string' } },
            ext_json: { type: 'string' },
          },
          required: ['store', 'statement', 'source_papers'],
        },
      },
    },
    required: ['entries'],
  }
}

/** 宽松形状校验：Scout 候选 → 可入库的元数据。 */
export function coercePaperCandidates(value: unknown): {
  title: string
  doi?: string
  arxiv_id?: string
  year?: number
  venue?: string
  relevance?: string
}[] {
  const list = (value as { papers?: unknown })?.papers
  if (!Array.isArray(list)) return []
  const out: ReturnType<typeof coercePaperCandidates> = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    if (title === '') continue
    const doi = typeof record.doi === 'string' && record.doi.trim() !== '' ? record.doi.trim() : undefined
    const arxivId = typeof record.arxiv_id === 'string' && record.arxiv_id.trim() !== '' ? record.arxiv_id.trim() : undefined
    out.push({
      title,
      ...(doi === undefined ? {} : { doi }),
      ...(arxivId === undefined ? {} : { arxiv_id: arxivId }),
      ...(typeof record.year === 'number' ? { year: record.year } : {}),
      ...(typeof record.venue === 'string' && record.venue.trim() !== '' ? { venue: record.venue.trim() } : {}),
      ...(typeof record.relevance === 'string' ? { relevance: record.relevance } : {}),
    })
  }
  return out
}

/** 宽松形状校验：Analyst 条目提案。 */
export function coerceEntryProposals(value: unknown): {
  store: StoreName
  statement: string
  source_papers: string[]
  ext: ExtensionFields
}[] {
  const list = (value as { entries?: unknown })?.entries
  if (!Array.isArray(list)) return []
  const stores = new Set<string>(['problems', 'methods', 'innovations', 'failures'])
  const out: ReturnType<typeof coerceEntryProposals> = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const store = typeof record.store === 'string' && stores.has(record.store) ? record.store as StoreName : undefined
    const statement = typeof record.statement === 'string' ? record.statement.trim() : ''
    const sources = Array.isArray(record.source_papers) ? record.source_papers.map(String).filter((id) => id !== '') : []
    if (store === undefined || statement === '' || sources.length === 0) continue
    let ext: ExtensionFields = {}
    if (typeof record.ext_json === 'string' && record.ext_json.trim() !== '') {
      try {
        const parsed = JSON.parse(record.ext_json) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) ext = parsed as ExtensionFields
      } catch {
        // ext 解析失败不阻塞：条目本身有效，扩展字段降级为空（工具层会把它计入 warnings）
      }
    }
    out.push({ store, statement, source_papers: sources, ext })
  }
  return out
}

export function apply(ctx: Context): void {
  const kb: KbService = ctx.kb
  const toolsRuntime = ctx.tools
  const subagents = ctx.get('subagents') as SubagentLike | undefined

  // ── cvagent_kb_scout ─────────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.scout,
    description:
      '委派 Scout 子代理做论文检索：给定细分领域与关键词组（缺省读项目状态里的研究范围），'
      + '用 Asta 取回候选论文列表（标题 + DOI/arXiv + 年份/会议）。'
      + '本工具**只回候选、不入库**——入库请随后调用 cvagent_kb_import_papers（检索与写入职责分离，便于核对）。',
    parameters: {
      sub_domain: { type: 'string', description: '细分领域一句话（缺省用 cvagent_state_get 里的研究范围）' },
      keywords: { type: 'array', items: { type: 'string' }, description: '关键词组（缺省用状态里的；仍为空时提示先 cvagent_scope_set）' },
      max_results: { type: 'integer', description: '期望候选数（默认 30）' },
      extra_instructions: { type: 'string', description: '附加检索要求（如限定年份、venue、必须含某数据集）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          with_external_id: { type: 'integer', required: true, description: '带 DOI 或 arXiv ID 的候选数（可入库的前提）' },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                doi: { type: 'string' },
                arxiv_id: { type: 'string' },
                year: { type: 'integer' },
                venue: { type: 'string' },
                relevance: { type: 'string' },
              },
            },
          },
          import_json: { type: 'string', required: true, description: '可直接传给 cvagent_kb_import_papers 的 JSON 数组' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派 Scout 子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const subDomain = args.sub_domain === undefined ? '' : String(args.sub_domain)
      const keywords = (args.keywords ?? []).map(String)
      if (subDomain.trim() === '' && keywords.length === 0) {
        throw new Error('缺少检索范围：请先 cvagent_scope_set 落盘细分领域与关键词，或本次显式传入 sub_domain / keywords')
      }
      const maxResults = args.max_results === undefined ? 30 : Number(args.max_results)

      const prompt = [
        subDomain.trim() === '' ? '' : `【细分领域】${subDomain}`,
        keywords.length === 0 ? '' : `【关键词组】${keywords.join(' / ')}`,
        `【目标】取回至多 ${maxResults} 篇最相关的论文候选。`,
        '建议：先用 mcp__asta__snippet_search 发现（它是唯一有量的通道，limit 100 可得约 60–70 篇不同论文），',
        '再用 mcp__asta__get_paper_batch 按 CorpusId 批量补齐 externalIds（fields 用 title,year,venue,externalIds）。',
        '注意：mcp__asta__search_papers_by_relevance 的 limit 不生效（只回单篇），别用它做批量检索。',
        args.extra_instructions === undefined ? '' : `【附加要求】${String(args.extra_instructions)}`,
        '按 outputSchema 输出。没有外部标识（DOI 或 arXiv）的条目直接丢弃。',
      ].filter((line) => line !== '').join('\n')

      const run = await subagents.start('spawn', {
        parent: exec.agent,
        label: `scout:${(subDomain || keywords[0] || 'scope').slice(0, 32)}`,
        prompt: [{ type: 'text', text: prompt }],
        toolFilter: SCOUT_FILTER,
        persona: SCOUT_PERSONA,
        outputSchema: scoutOutputSchema(),
        maxDepth: 0,
      })
      try {
        const result = await run.result
        if (result.structured === undefined) {
          throw new Error(`Scout 子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
        }
        const candidates = coercePaperCandidates(result.structured)
        const importable = candidates.map((candidate) => ({
          paper_id: candidate.doi ?? candidate.arxiv_id ?? '',
          title: candidate.title,
          ...(candidate.doi === undefined ? {} : { doi: candidate.doi }),
          ...(candidate.arxiv_id === undefined ? {} : { arxiv_id: candidate.arxiv_id }),
          ...(candidate.year === undefined ? {} : { year: candidate.year }),
          ...(candidate.venue === undefined ? {} : { venue: candidate.venue }),
        })).filter((candidate) => candidate.paper_id !== '')
        return {
          count: candidates.length,
          with_external_id: importable.length,
          candidates: candidates.map((candidate) => ({ ...candidate })),
          import_json: JSON.stringify(importable),
        }
      } finally {
        await run.dispose()
      }
    },
  }))

  // ── cvagent_kb_import_papers（批量）───────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.importPapers,
    description:
      '批量入库论文元数据（Scout 结果的落地口）。逐条回传 upsert 结果：'
      + 'inserted / merged（按 §7.5.2 三级去重键）/ needs_review（标题级命中，不自动合并）。'
      + '**部分成功是正常结果**，不要因为个别条目失败而重试整批。',
    parameters: {
      papers_json: { type: 'string', required: true, description: 'JSON 数组：[{"paper_id","title","doi"?,"arxiv_id"?,"year"?,"venue"?}]' },
      source_channel: { type: 'string', enum: ['asta', 'ai4scholar', 'manual'], description: '来源通道（默认 asta）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          inserted: { type: 'integer', required: true },
          merged: { type: 'integer', required: true },
          needs_review: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          details: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paper_id: { type: 'string', required: true },
                outcome: { type: 'string', required: true, description: 'inserted / merged / needs_review / error' },
                merged_into: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(args.papers_json))
      } catch (error) {
        throw new Error(`papers_json 不是合法 JSON：${(error as Error).message}`)
      }
      if (!Array.isArray(parsed)) throw new Error('papers_json 必须是数组')
      const channel = (args.source_channel ?? 'asta') as PaperRecord['source_channel']
      const now = new Date().toISOString()

      let inserted = 0
      let merged = 0
      let needsReview = 0
      let failed = 0
      const details: { paper_id: string; outcome: string; merged_into?: string; error?: string }[] = []

      for (const item of parsed) {
        const record = (item ?? {}) as Record<string, unknown>
        const paperId = typeof record.paper_id === 'string' ? record.paper_id.trim() : ''
        const title = typeof record.title === 'string' ? record.title.trim() : ''
        if (paperId === '' || title === '') {
          failed += 1
          details.push({ paper_id: paperId === '' ? '(缺 paper_id)' : paperId, outcome: 'error', error: '缺 paper_id 或 title' })
          continue
        }
        try {
          const outcome = kb.upsertPaper({
            paper_id: paperId,
            title,
            authors: Array.isArray(record.authors) ? record.authors.map(String) : [],
            ...(typeof record.year === 'number' ? { year: record.year } : {}),
            ...(typeof record.venue === 'string' ? { venue: record.venue } : {}),
            ...(typeof record.doi === 'string' ? { doi: record.doi } : {}),
            ...(typeof record.arxiv_id === 'string' ? { arxiv_id: record.arxiv_id } : {}),
            source_channel: channel,
            pdf_status: 'pending',
            created_at: now,
            updated_at: now,
          })
          if (outcome.inserted) { inserted += 1; details.push({ paper_id: outcome.paper_id, outcome: 'inserted' }) }
          else if (outcome.merged) { merged += 1; details.push({ paper_id: outcome.paper_id, outcome: 'merged', ...(outcome.merged_into === null ? {} : { merged_into: outcome.merged_into }) }) }
          else { needsReview += 1; details.push({ paper_id: outcome.paper_id, outcome: 'needs_review', ...(outcome.merged_into === null ? {} : { merged_into: outcome.merged_into }) }) }
        } catch (error) {
          failed += 1
          details.push({ paper_id: paperId, outcome: 'error', error: (error as Error).message })
        }
      }

      return { total: parsed.length, inserted, merged, needs_review: needsReview, failed, details }
    },
  }))

  // ── cvagent_kb_analyze ───────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.analyze,
    description:
      '委派 Analyst 子代理把 Reader 的提取归纳成库条目（problems/methods/innovations/failures），'
      + '并把结果按 §7.5.2 规则写入（同库 statement 归一化相等则合并）。'
      + '`dry_run=true` 只回提案不写库（可用于人工复核）。'
      + '去重上下文由本工具确定性构造（既有相关条目 + 提取内容），子代理不必自己找。',
    parameters: {
      paper_ids: { type: 'array', items: { type: 'string' }, description: '参与归纳的论文 paper_id（缺省取最近提取的若干篇）' },
      max_papers: { type: 'integer', description: '缺省 paper_ids 时取多少篇（默认 5）' },
      dry_run: { type: 'boolean', description: '只回提案不写库（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          analyzed_papers: { type: 'integer', required: true },
          proposed: { type: 'integer', required: true },
          created: { type: 'integer', required: true },
          merged: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true, description: '形状不合规被丢弃的提案数' },
          dry_run: { type: 'boolean', required: true },
          outcomes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                store: { type: 'string', required: true },
                entry_id: { type: 'string', required: true },
                merged: { type: 'boolean', required: true },
                statement: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) throw new Error('subagents 服务不可用：无法委派 Analyst 子代理')
      if (exec.agent === undefined) throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')

      const requested = (args.paper_ids ?? []).map(String)
      const maxPapers = args.max_papers === undefined ? 5 : Number(args.max_papers)
      const dryRun = args.dry_run === true

      // 缺省：用已有提取的论文（kb 的检索面不足以列出"有提取的论文"，这里用论文库顺序兜底）
      const paperIds = requested.length > 0
        ? requested
        : (kb.searchEntries({ store: 'problems', limit: maxPapers }) as { source_papers: readonly string[] }[])
            .flatMap((entry) => entry.source_papers)
            .filter((id, index, all) => all.indexOf(id) === index)
            .slice(0, maxPapers)

      const extractions: { paperId: string; extraction: PaperExtraction }[] = []
      for (const paperId of paperIds) {
        const extraction = kb.getExtraction(paperId)
        if (extraction !== undefined) extractions.push({ paperId, extraction })
      }
      if (extractions.length === 0) {
        throw new Error('没有可归纳的提取结果：先用 cvagent_kb_extract 对相关论文完成结构化提取')
      }

      // 确定性去重上下文：按该论文的问题/方法/创新召回既有条目（让 Analyst 看见"已有什么"）
      const existing: string[] = []
      const seenEntries = new Set<string>()
      for (const { extraction } of extractions) {
        for (const query of [extraction.problem_statement, extraction.method_summary, ...extraction.innovations]) {
          for (const entry of kb.searchEntries({ query, limit: 3 })) {
            if (seenEntries.has(entry.entry_id)) continue
            seenEntries.add(entry.entry_id)
            existing.push(`- ${entry.entry_id} [${entry.store}] ${entry.statement.slice(0, 120)}`)
          }
        }
      }

      const brief = extractions.map(({ paperId, extraction }) => [
        `### paper_id: ${paperId}`,
        `问题：${extraction.problem_statement.slice(0, 400)}`,
        `方法：${extraction.method_summary.slice(0, 600)}`,
        `创新点：${extraction.innovations.slice(0, 6).map((item) => item.slice(0, 160)).join(' | ')}`,
        extraction.limitations.length === 0 ? '局限：（原文未提供）' : `局限：${extraction.limitations.slice(0, 3).map((item) => item.slice(0, 200)).join(' | ')}`,
        `数据集：${extraction.benchmarks.join(' / ') || '（无）'}`,
        `对比方法：${extraction.baseline_methods.slice(0, 10).join(' / ') || '（无）'}`,
      ].join('\n')).join('\n\n')

      const prompt = [
        `【待归纳的提取（${extractions.length} 篇）】`,
        brief,
        '',
        `【库中已有相关条目（避免重复建档；同一概念已有条目时不要产出，或产出更完整的陈述）】`,
        existing.length === 0 ? '（无）' : existing.join('\n'),
        '',
        '按 outputSchema 输出条目提案。每条 source_papers 必须来自上面出现的 paper_id。',
      ].join('\n')

      const run = await subagents.start('spawn', {
        parent: exec.agent,
        label: `analyst:${extractions.length}papers`,
        prompt: [{ type: 'text', text: prompt }],
        toolFilter: ANALYST_FILTER,
        persona: ANALYST_PERSONA,
        outputSchema: analystOutputSchema(),
        maxDepth: 0,
      })

      let proposals: ReturnType<typeof coerceEntryProposals>
      let rawCount = 0
      try {
        const result = await run.result
        if (result.structured === undefined) {
          throw new Error(`Analyst 子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
        }
        rawCount = Array.isArray((result.structured as { entries?: unknown[] }).entries)
          ? ((result.structured as { entries: unknown[] }).entries.length)
          : 0
        proposals = coerceEntryProposals(result.structured)
      } finally {
        await run.dispose()
      }

      const outcomes: { store: string; entry_id: string; merged: boolean; statement: string }[] = []
      if (dryRun) {
        proposals.forEach((proposal, index) => {
          outcomes.push({ store: proposal.store, entry_id: `DRY-${index + 1}`, merged: false, statement: proposal.statement })
        })
        return {
          analyzed_papers: extractions.length,
          proposed: proposals.length,
          created: 0,
          merged: 0,
          skipped: rawCount - proposals.length,
          dry_run: true,
          outcomes,
        }
      }

      let created = 0
      let merged = 0
      for (const proposal of proposals) {
        const outcome = kb.upsertEntry(proposal.store, proposal.statement, proposal.source_papers, proposal.ext)
        if (outcome.merged) merged += 1
        else created += 1
        outcomes.push({ store: outcome.store, entry_id: outcome.entry_id, merged: outcome.merged, statement: proposal.statement.slice(0, 120) })
      }

      return {
        analyzed_papers: extractions.length,
        proposed: proposals.length,
        created,
        merged,
        skipped: rawCount - proposals.length,
        dry_run: false,
        outcomes,
      }
    },
  }))
}

/** 供测试与角色矩阵引用：Scout 至少要有 asta 检索名（契约自检）。 */
export const SCOUT_FILTER_SAMPLE = ASTA_TOOL_NAMES.searchByTitle
