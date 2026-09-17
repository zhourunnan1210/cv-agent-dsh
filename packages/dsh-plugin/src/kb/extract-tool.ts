/**
 * cvagent_kb_extract：Reader 子代理委派工具（P2-6b）。
 *
 * 用 Phase 1 实证的机制把「单篇论文结构化提取」交给一个上下文隔离的
 * Reader 子代理（勘误 §4.1 / §4.2）：
 * - `spawn` provider（不继承父历史，§5.2.1）；
 * - `toolFilter.allow = ['read']`：子代理只有文件读取工具（隔离红线）；
 * - `persona` = Reader 角色（§16.2 五段式里 1/3/4 段）；
 * - `outputSchema` = PaperExtraction 契约编译的 JSON Schema——子代理只能
 *   按十字段结构应答，`structured` 字段存在即契约成立（§5.2.1 ③）；
 * - 主 Agent 只收到结构化结果，全文不进主上下文（原则四）。
 *
 * 前置：论文已解析（papers.md_path 非空）。解析本身是落盘流水线
 * （scripts/parse-one.mjs 或后续 batch 工具）的职责，与提取分离（§5.2/5.3）。
 *
 * 落位：kb 组的消费者（inject kb + 宿主 tools/subagents），行名
 * cv-agent-dsh/kb-extract，加入 preset 的 kb isolate group。
 *
 * @module cv-agent-dsh/kb-extract
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'

import type { PaperExtraction, ExtractionQuality } from '@cv-research/core'

import { KB_TOOLS } from '../tools/names.js'
import type { KbService } from './service.js'
import { SUBAGENT_MAX_DEPTH } from '../subagent.js'
import type { SubagentLike } from '../subagent.js'

export const name = 'cvagent-kb-extract-tool'
export const inject = ['kb', 'tools']

/** 子代理契约允许的最小面：只有读文件。 */
export const READER_TOOL_FILTER = { allow: ['read'] } as const

/** Reader 角色 persona（§5.3 提取表的执行者）。 */
export const READER_PERSONA = [
  '你是 cv-research 的 Reader 子代理：一次只处理一篇论文的结构化提取。',
  '读入指定路径的论文全文 Markdown（可能含 MinerU 解析噪声，如 OCR 错字），',
  '按给定 outputSchema 提取十字段：problem_statement（摘要+引言）、',
  'method_summary（方法章节）、innovations（引言+结论的创新点列表）、',
  'future_work（结论+讨论；没有就空数组）、limitations（局限章节+批判性分析，',
  '包括负面对比结果）、benchmarks（实验用数据集名）、metrics（报告指标名）、',
  'baseline_methods（对比方法名）、extraction_quality。',
  '只报告论文里写的事实，不补写、不猜测；没有任何额外输出，',
  '全部内容走结构化输出机制。',
].join(' ')

/** 契约编译：PaperExtraction 的 JSON Schema（outputSchema 用）。 */
export function extractionOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      paper_id: { type: 'string' },
      problem_statement: { type: 'string' },
      method_summary: { type: 'string' },
      innovations: { type: 'array', items: { type: 'string' } },
      future_work: { type: 'array', items: { type: 'string' } },
      limitations: { type: 'array', items: { type: 'string' } },
      benchmarks: { type: 'array', items: { type: 'string' } },
      metrics: { type: 'array', items: { type: 'string' } },
      baseline_methods: { type: 'array', items: { type: 'string' } },
      extraction_quality: { type: 'string', enum: ['full_text', 'abstract_only'] },
    },
    required: [
      'problem_statement', 'method_summary', 'innovations', 'future_work',
      'limitations', 'benchmarks', 'metrics', 'baseline_methods', 'extraction_quality',
    ],
  }
}

/** 校验子代理返回的结构化结果是不是 PaperExtraction（宽松形状校验）。 */
function coerceExtraction(paperId: string, value: unknown): PaperExtraction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const str = (key: string) => (typeof candidate[key] === 'string' ? (candidate[key] as string) : '')
  const arr = (key: string) => (Array.isArray(candidate[key]) ? (candidate[key] as unknown[]).map(String) : [])
  if (str('problem_statement') === '' || str('method_summary') === '') return undefined
  return {
    paper_id: paperId,
    problem_statement: str('problem_statement'),
    method_summary: str('method_summary'),
    innovations: arr('innovations'),
    future_work: arr('future_work'),
    limitations: arr('limitations'),
    benchmarks: arr('benchmarks'),
    metrics: arr('metrics'),
    baseline_methods: arr('baseline_methods'),
    extraction_quality: (candidate.extraction_quality === 'abstract_only' ? 'abstract_only' : 'full_text') as ExtractionQuality,
    extracted_at: new Date().toISOString(),
  }
}

function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context): void {
  const kb: KbService = ctx.kb
  const toolsRuntime = ctx.tools
  const subagents = ctx.get('subagents') as SubagentLike | undefined

  toolsRuntime.register(defineTool({
    name: KB_TOOLS.extract,
    description:
      '把一篇论文的全文解析产物交给一个上下文隔离的 Reader 子代理做结构化提取（§5.3 十字段），'
      + '结果写入论文库。前置：该论文已解析（papers.md_path 非空）。'
      + '子代理只有文件读取工具；主 Agent 只收到结构化结果，全文不进主上下文。',
    parameters: {
      paper_id: { type: 'string', required: true, description: '论文 paper_id（DOI/arXiv/local:<key>）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paper_id: { type: 'string', required: true },
          extraction_quality: { type: 'string', required: true },
          summary: { type: 'string', required: true, description: '提取结果一句话摘要（问题+方法）' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      const paperId = String(args.paper_id)
      const paper = kb.getPaper(paperId)
      if (paper === undefined) {
        throw new Error(`论文不存在：${paperId}（先用 cvagent_kb_import_paper 入库）`)
      }
      if (paper.md_path === undefined) {
        throw new Error(`论文尚未解析（md_path 为空）：先跑落盘流水线（scripts/parse-one.mjs），或改走 abstract_only 通道`)
      }
      if (subagents === undefined) {
        throw new Error('subagents 服务不可用：无法委派 Reader 子代理')
      }
      if (exec.agent === undefined) {
        throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')
      }

      const mdAbsolute = resolve(process.cwd(), paper.md_path)
      const prompt = [
        `论文：${paper.title}`,
        `paper_id：${paperId}`,
        `全文 Markdown 绝对路径：${mdAbsolute}`,
        `请读入该文件，按 outputSchema 完成十字段结构化提取。`,
      ].join('\n')

      const run = await subagents.start('spawn', {
        signal: exec.signal,
        parent: exec.agent,
        label: `reader:${paperId}`,
        prompt: [{ type: 'text', text: prompt }],
        toolFilter: READER_TOOL_FILTER,
        persona: READER_PERSONA,
        outputSchema: extractionOutputSchema(),
        maxDepth: SUBAGENT_MAX_DEPTH,
      })

      try {
        const result = await run.result
        if (result.structured === undefined) {
          throw new Error(`Reader 子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
        }
        const extraction = coerceExtraction(paperId, result.structured)
        if (extraction === undefined) {
          throw new Error('Reader 子代理返回的结构化结果形状非法（缺 problem_statement 或 method_summary）')
        }
        kb.saveExtraction(extraction)
        return {
          paper_id: paperId,
          extraction_quality: extraction.extraction_quality,
          summary: `${extraction.problem_statement.slice(0, 80)}｜${extraction.method_summary.slice(0, 80)}`,
        }
      } finally {
        await run.dispose()
      }
    },
  }))
}
