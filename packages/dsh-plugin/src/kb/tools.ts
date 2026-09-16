/**
 * 知识库族工具行（v1.2 §15.2 的落地；本批先实现 import_paper）。
 *
 * 本行是 `kb` 服务的**消费者**：组合文件里必须与 `cv-agent-dsh/kb`
 * 同处一个 `isolate: { kb: true }` 的 group（勘误 §4.4.1 裁定）。
 *
 * @module cv-agent-dsh/kb-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import type { PaperRecord, PaperSourceChannel, PaperPdfStatus } from '@cv-research/core'

import { KB_TOOLS } from '../tools/names.js'
import type { KbService } from './service.js'

export const name = 'cvagent-kb-tools'
export const inject = ['kb', 'tools']

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context): void {
  const kb: KbService = ctx.kb
  // E17：保留方法调用形态，不解构。
  const toolsRuntime = ctx.tools

  toolsRuntime.register(defineTool({
    name: KB_TOOLS.importPaper,
    description:
      '把一篇论文的规范化元数据写入本地论文库（metadata.db）。按 §7.5.2 去重键处理：'
      + 'paper_id 或 doi/arxiv_id/pmid 命中则合并（保留较长摘要、作者并集、解析状态不回退）；'
      + '标题归一化命中只返回 needs_review 提示，不自动写库。source_channel 记录来源通道。',
    parameters: {
      paper_id: { type: 'string', required: true, description: 'DOI 或 arXiv ID（会归一化）；本地论文可用 local:<hash>' },
      title: { type: 'string', required: true, description: '论文标题' },
      authors: { type: 'array', items: { type: 'string' }, description: '作者列表' },
      year: { type: 'integer', description: '发表年份' },
      venue: { type: 'string', description: '会议/期刊名' },
      citation_count: { type: 'integer', description: '引用数' },
      doi: { type: 'string', description: 'DOI（可与 paper_id 相同）' },
      arxiv_id: { type: 'string', description: 'arXiv ID' },
      pmid: { type: 'string', description: 'PMID' },
      url: { type: 'string', description: '论文页面 URL' },
      oa_pdf_url: { type: 'string', description: '开放获取 PDF URL' },
      abstract: { type: 'string', description: '摘要' },
      pdf_path: { type: 'string', description: '本地 PDF 文件路径（落盘流水线用，可选）' },
      source_channel: {
        type: 'string',
        enum: ['asta', 'ai4scholar', 'manual'],
        description: '来源通道（默认 asta）',
      },
      pdf_status: {
        type: 'string',
        enum: ['pending', 'downloaded', 'missing'],
        description: 'PDF 落盘状态（默认 pending）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paper_id: { type: 'string', required: true, description: '归一化后的 paper_id' },
          inserted: { type: 'boolean', required: true },
          merged: { type: 'boolean', required: true },
          matched_kind: { type: 'string', enum: ['paper_id', 'external_id', 'title', 'none'], description: '命中的去重键级别；none=无命中' },
          merged_into: { type: 'string', description: '合并目标 paper_id；未合并为空串' },
          needs_review: { type: 'boolean', required: true, description: '标题级命中：人工复核线索，未写库' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const now = new Date().toISOString()
      const record: PaperRecord = {
        paper_id: String(args.paper_id),
        title: String(args.title),
        authors: args.authors === undefined ? [] : args.authors.map((author) => String(author)),
        ...(args.year === undefined ? {} : { year: args.year }),
        ...(args.venue === undefined ? {} : { venue: String(args.venue) }),
        ...(args.citation_count === undefined ? {} : { citation_count: args.citation_count }),
        ...(args.doi === undefined ? {} : { doi: String(args.doi) }),
        ...(args.arxiv_id === undefined ? {} : { arxiv_id: String(args.arxiv_id) }),
        ...(args.pmid === undefined ? {} : { pmid: String(args.pmid) }),
        ...(args.url === undefined ? {} : { url: String(args.url) }),
        ...(args.oa_pdf_url === undefined ? {} : { oa_pdf_url: String(args.oa_pdf_url) }),
        ...(args.abstract === undefined ? {} : { abstract: String(args.abstract) }),
        ...(args.pdf_path === undefined ? {} : { pdf_path: String(args.pdf_path) }),
        source_channel: (args.source_channel ?? 'asta') as PaperSourceChannel,
        pdf_status: (args.pdf_status ?? 'pending') as PaperPdfStatus,
        created_at: now,
        updated_at: now,
      }
      const outcome = kb.upsertPaper(record)
      // 输出 schema 不收 null：映射为字符串哨兵值（显式定型避免字面量加宽）
      const matchedKind: 'paper_id' | 'external_id' | 'title' | 'none' = outcome.matched_kind ?? 'none'
      return {
        paper_id: outcome.paper_id,
        inserted: outcome.inserted,
        merged: outcome.merged,
        matched_kind: matchedKind,
        merged_into: outcome.merged_into ?? '',
        needs_review: outcome.needs_review,
      }
    },
  }))
}
