/**
 * 三库读写工具行（P3-1）：`cvagent_kb_upsert_entry` / `cvagent_kb_search` / `cvagent_kb_summary`。
 *
 * 为什么单独一行而不是塞进 `kb-tools`：这三件工具的**消费者不同**——`kb-tools`
 * 的 import_paper 面向 Scout（入库论文元数据），而这三个面向 Analyst（写三库条目）
 * 与 Orchestrator（idea 生成/打分前检索三库）。拆行让角色矩阵的 `toolFilter`
 * 可以按需给：Reader 拿不到三库写权限。
 *
 * 落位：与 `cv-agent-dsh/kb` 同处 `isolate: { kb: true }` 的 group（勘误 §4.4.1）。
 *
 * @module cv-agent-dsh/kb-entries
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import type { ExtensionFields, StoreName } from '@cv-research/core'

import { KB_TOOLS } from '../tools/names.js'
import type { KbService } from './service.js'

export const name = 'cvagent-kb-entries'
export const inject = ['kb', 'tools']

const STORE_ENUM = ['problems', 'methods', 'innovations', 'failures'] as const

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context): void {
  const kb: KbService = ctx.kb
  // E17：保留方法调用形态，不解构。
  const toolsRuntime = ctx.tools

  // ── 写入（Analyst 角色）────────────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.upsertEntry,
    description:
      '写入一条知识库条目（problems / methods / innovations / **failures 失败方法库**）。'
      + '按 §7.5.2 合并规则：同库内 statement 归一化（去全部非字母数字后小写）相等则**合并**——'
      + '保留较长陈述、source_papers 取并集、ext 按 pack 逐键浅合并；否则新建条目并分配 ID（P/M/I/F + 三位序号）。'
      + '条目必须可溯源：source_papers 里的 paper_id 应当真实存在于论文库。'
      + '失败库条目的 statement 写「做法 → 失败表现」，ext 带 failure_mode / conditions / revisit_when。',
    parameters: {
      store: { type: 'string', required: true, enum: [...STORE_ENUM], description: '目标库' },
      statement: { type: 'string', required: true, description: '条目陈述（中文描述 + 英文专有名词保留原文）' },
      source_papers: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '来源论文 paper_id 列表（至少一条）',
      },
      ext_json: {
        type: 'string',
        description: '领域扩展字段的 JSON 文本，形如 {"deepfake-detection":{"paradigm":"hybrid"}}；缺省为 {}',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entry_id: { type: 'string', required: true, description: '条目 ID（合并时是被并入的既有 ID）' },
          store: { type: 'string', required: true },
          merged: { type: 'boolean', required: true, description: 'true=并入既有条目，false=新建' },
          merged_into: { type: 'string', description: '合并目标 ID；新建时为空串' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const store = String(args.store) as StoreName
      const statement = String(args.statement).trim()
      if (statement === '') throw new Error('statement 不可为空')
      const sources = (args.source_papers ?? []).map((item) => String(item))
      if (sources.length === 0) throw new Error('source_papers 至少一条：三库条目必须可溯源到论文')

      let ext: ExtensionFields = {}
      if (args.ext_json !== undefined && String(args.ext_json).trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(String(args.ext_json))
        } catch (error) {
          throw new Error(`ext_json 不是合法 JSON：${(error as Error).message}`)
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('ext_json 必须是一个 JSON 对象（形如 {"<pack-id>":{...}}）')
        }
        ext = parsed as ExtensionFields
      }

      const outcome = kb.upsertEntry(store, statement, sources, ext)
      return {
        entry_id: outcome.entry_id,
        store: outcome.store,
        merged: outcome.merged,
        merged_into: outcome.merged_into ?? '',
      }
    },
  }))

  // ── 检索（Orchestrator / Analyst）─────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.search,
    description:
      '检索三库条目。查询串 ≥3 字符走 FTS5 trigram 全文匹配（中文子串可用），'
      + '<3 字符自动回退子串匹配（trigram 对 2 字查询无效）；也可只给过滤条件'
      + '（store / source_paper）列出条目。跨库检索按 problems → methods → innovations 分组返回。',
    parameters: {
      query: { type: 'string', description: '关键词（可空：只按过滤条件列出条目）' },
      store: { type: 'string', enum: [...STORE_ENUM], description: '限定单一库；缺省搜三个库' },
      source_paper: { type: 'string', description: '只看「该论文作为来源之一」的条目' },
      limit: { type: 'integer', description: '每库最多返回条数（默认 20，上限 200）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true, description: '返回条目数' },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                entry_id: { type: 'string', required: true },
                store: { type: 'string', required: true },
                statement: { type: 'string', required: true },
                source_papers: { type: 'array', required: true, items: { type: 'string' } },
                ext_json: { type: 'string', required: true, description: '领域扩展字段的 JSON 文本' },
              },
            },
          },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const entries = kb.searchEntries({
        ...(args.query === undefined ? {} : { query: String(args.query) }),
        ...(args.store === undefined ? {} : { store: String(args.store) as StoreName }),
        ...(args.source_paper === undefined ? {} : { sourcePaper: String(args.source_paper) }),
        ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
      })
      return {
        count: entries.length,
        entries: entries.map((entry) => ({
          entry_id: entry.entry_id,
          store: entry.store,
          statement: entry.statement,
          source_papers: [...entry.source_papers],
          ext_json: JSON.stringify(entry.ext),
        })),
      }
    },
  }))

  // ── 总览（Orchestrator 决策用）────────────────────────────────────────
  toolsRuntime.register(defineTool({
    name: KB_TOOLS.summary,
    description:
      '知识库总览：论文库规模与来源通道、**已解析/已提取/尚待提取**三个数字、四库条目数与最近更新时间。'
      + '用于阶段推进判据（knowledge_building → idea_generation 的达标检查）、预算决策，'
      + '以及判断"提取环节有没有积压"（`pending_extraction` 大就说明该批量补课了）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          papers: { type: 'integer', required: true, description: '论文库总条数' },
          papers_by_channel: { type: 'string', required: true, description: '按来源通道的条数（JSON 文本）' },
          parsed: { type: 'integer', required: true, description: '已有全文解析（md_path 非空）的篇数' },
          extractions: { type: 'integer', required: true, description: '已完成的 Reader 结构化提取篇数' },
          pending_extraction: {
            type: 'integer',
            required: true,
            description: '已解析但还没做结构化提取的篇数——提取环节的待办量（>0 时可 cvagent_kb_extract 批量补）',
          },
          entries_problems: { type: 'integer', required: true },
          entries_methods: { type: 'integer', required: true },
          entries_innovations: { type: 'integer', required: true },
          entries_failures: { type: 'integer', required: true, description: '失败方法库条目数' },
          entries_total: { type: 'integer', required: true },
          latest_entry_update: { type: 'string', description: '三库最近一次更新时间；无条目时为空串' },
        },
      },
      render: renderJson,
    },
    async execute() {
      const summary = kb.entrySummary()
      return {
        papers: kb.count(),
        papers_by_channel: JSON.stringify(kb.countByChannel()),
        // `parsed` 早就该在这里：判据用它在门控里把关，而总览却不给——
        // 于是"已解析 154 / 已提取 21"这种系统性缺口要等到有人手动查库才会被发现。
        parsed: kb.parsedCount(),
        extractions: kb.extractionCount(),
        pending_extraction: kb.unextractedCount(),
        entries_problems: summary.counts.problems,
        entries_methods: summary.counts.methods,
        entries_innovations: summary.counts.innovations,
        entries_failures: summary.counts.failures,
        entries_total: summary.total,
        latest_entry_update: summary.latest_updated_at ?? '',
      }
    },
  }))
}
