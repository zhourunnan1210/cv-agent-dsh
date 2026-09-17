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
  '⚠️ `benchmarks` 只填**数据集/基准**的名称（如 FaceForensics++、Celeb-DF、GenImage）。',
  '伪造方法或生成器（FaceSwap、Face2Face、NeuralTextures、StyleGAN3、SDv21…）不是数据集，',
  '不要放进 benchmarks——它们属于方法/生成器；源语料（VoxCeleb2、LRS2）可以填。',
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

/**
 * 单篇提取结果。
 *
 * 形状由工具的 outputSchema 决定：`status` 区分成功/失败，失败时**只有** `error`，
 * 成功时**只有** `extraction_quality` + `summary`——避免出现"看起来成功但摘要是空的"。
 */
interface ExtractResult {
  paper_id: string
  title: string
  status: 'ok' | 'failed'
  extraction_quality?: string
  summary?: string
  error?: string
}

export function apply(ctx: Context): void {
  const kb: KbService = ctx.kb
  const toolsRuntime = ctx.tools
  const subagents = ctx.get('subagents') as SubagentLike | undefined

  toolsRuntime.register(defineTool({
    name: KB_TOOLS.extract,
    description:
      '把论文的全文解析产物交给**上下文隔离**的 Reader 子代理做结构化提取（§5.3 十字段），结果写入论文库。'
      + '两种用法：① 传 paper_id —— 提取指定那一篇（已提取过的会覆盖刷新）；'
      + '② 不传 paper_id、传 limit —— 由**库自己**挑出"已解析但还没提取"的若干篇依次处理（**批量补课**，'
      + '适用于库里积压着一批已解析未提取的论文时，不必逐篇调用）。'
      + '前置：论文已解析（md_path 非空）。子代理只有文件读取工具；主 Agent 只收到结构化结果，全文不进主上下文。'
      + '**单篇失败不影响其余**：每篇的结果分别回传，部分成功是正常结果。',
    parameters: {
      paper_id: { type: 'string', description: '论文 paper_id（DOI/arXiv/local:<key>）；给了就只处理这一篇' },
      limit: { type: 'integer', description: '批量模式：本次最多处理几篇"已解析未提取"的论文（1–10，默认 3）。给了 paper_id 时忽略' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true, description: '本次实际处理的篇数' },
          succeeded: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          results: {
            type: 'array',
            required: true,
            description: '逐篇结果（顺序与处理顺序一致）',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paper_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['ok', 'failed'] },
                extraction_quality: { type: 'string', description: '成功时为 full_text / abstract_only' },
                summary: { type: 'string', description: '成功时的一句话摘要（问题｜方法）' },
                error: { type: 'string', description: '失败时的原因（该篇独立失败，不影响其余）' },
              },
            },
          },
          remaining: { type: 'integer', required: true, description: '本次之后，库里还剩多少篇「已解析未提取」——据此决定要不要接着调' },
        },
      },
      render: renderJson,
    },
    async execute(args, exec) {
      if (subagents === undefined) {
        throw new Error('subagents 服务不可用：无法委派 Reader 子代理')
      }
      if (exec.agent === undefined) {
        throw new Error('调用缺少 agent 上下文：无法建立委派父子关系')
      }

      // ── 选片：显式一篇 / 库里挑一批 ─────────────────────────────────────
      let targets: Array<{ paper_id: string; title: string; md_path: string }>
      if (args.paper_id !== undefined) {
        const paperId = String(args.paper_id)
        const paper = kb.getPaper(paperId)
        if (paper === undefined) {
          throw new Error(`论文不存在：${paperId}（先用 cvagent_kb_import_paper 入库）`)
        }
        if (paper.md_path === undefined) {
          throw new Error(`论文尚未解析（md_path 为空）：先跑落盘流水线（scripts/parse-one.mjs），或改走 abstract_only 通道`)
        }
        targets = [{ paper_id: paperId, title: paper.title, md_path: paper.md_path }]
      } else {
        const limit = Math.min(10, Math.max(1, args.limit === undefined ? 3 : Number(args.limit)))
        targets = kb.listUnextracted(limit)
        if (targets.length === 0) {
          throw new Error(
            '没有"已解析但未提取"的论文：要么都提取过了，要么还没有解析产物。'
            + '可用 cvagent_kb_summary 看「已解析 / 已提取」两个数字，或先跑解析流水线。',
          )
        }
      }

      // ── 逐篇处理：单篇失败被收起成该项的 error，不打断整批 ────────────────
      const results: ExtractResult[] = []
      for (const target of targets) {
        const mdAbsolute = resolve(process.cwd(), target.md_path)
        const prompt = [
          `论文：${target.title}`,
          `paper_id：${target.paper_id}`,
          `全文 Markdown 绝对路径：${mdAbsolute}`,
          `请读入该文件，按 outputSchema 完成十字段结构化提取。`,
        ].join('\n')

        let run
        try {
          run = await subagents.start('spawn', {
            signal: exec.signal,
            parent: exec.agent,
            label: `reader:${target.paper_id}`,
            prompt: [{ type: 'text', text: prompt }],
            toolFilter: READER_TOOL_FILTER,
            persona: READER_PERSONA,
            outputSchema: extractionOutputSchema(),
            maxDepth: SUBAGENT_MAX_DEPTH,
          })
        } catch (error) {
          results.push({
            paper_id: target.paper_id,
            title: target.title,
            status: 'failed',
            error: `委派失败：${error instanceof Error ? error.message : String(error)}`,
          })
          continue
        }

        try {
          const result = await run.result
          if (result.structured === undefined) {
            throw new Error(`Reader 子代理未按契约应答（stopReason=${result.stopReason}${result.diagnostic ? `，${result.diagnostic}` : ''}）`)
          }
          const extraction = coerceExtraction(target.paper_id, result.structured)
          if (extraction === undefined) {
            throw new Error('Reader 返回的结构化结果形状非法（缺 problem_statement 或 method_summary）')
          }
          kb.saveExtraction(extraction)
          results.push({
            paper_id: target.paper_id,
            title: target.title,
            status: 'ok',
            extraction_quality: extraction.extraction_quality,
            summary: `${extraction.problem_statement.slice(0, 80)}｜${extraction.method_summary.slice(0, 80)}`,
          })
        } catch (error) {
          results.push({
            paper_id: target.paper_id,
            title: target.title,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          await run.dispose()
        }
      }

      const succeeded = results.filter((item) => item.status === 'ok').length
      return {
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
        results,
        // 让"还剩多少"可见：模型不必自己算，也就能自己决定要不要接着调。
        remaining: kb.unextractedCount(),
      }
    },
  }))
}
