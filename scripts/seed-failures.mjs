/**
 * 失败方法库种子：从 Reader 提取的 `limitations` **派生**初始条目（勘误 §12.2 来源②）。
 *
 * 为什么从 limitations 起步：21 篇提取里现成有约 60 条「作者自述的不足/负面对比结果」，
 * 它们是**有出处的**失败事实（`source_papers` 指向真实论文），比手写种子可靠得多。
 *
 * 但要注意语义差别：`limitations` 是「这个方法/这篇论文的局限」，
 * 失败库要的是「某个做法在某个条件下不成立」。因此本脚本做**有损但可审计**的转换：
 *   statement = 「<方法名>：<局限原文要点>」
 *   ext.failure_mode 由局限文本的关键词判定（不猜的给 other）
 *   ext.conditions 从方法概述/数据集里带出（有则带，无则空）
 *   ext.revisit_when 留空 → 由人工或 Analyst 后续补（**不编造**）
 *
 * 用法：
 *   node scripts/seed-failures.mjs [--limit N] [--out data/papers/entries/failures-seed.json]
 *   然后：node scripts/load-entries.mjs data/papers/entries/failures-seed.json
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const optValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}
const limit = Number(optValue('--limit') ?? 0)
const OUT = optValue('--out') ?? 'data/papers/entries/failures-seed.json'

const db = new PaperDatabase('data/papers/metadata.db')
const titleById = new Map(db.raw.prepare('SELECT paper_id, title FROM papers').all().map((row) => [row.paper_id, row.title]))

/** 失败模式的关键词判定（**不猜**：拿不准就给 other，留给人工/Analyst 订正）。 */
function classifyFailureMode(text) {
  const value = text.toLowerCase()
  if (/reproduc|not reproducible|seed|variance|统计显著|复现|significant/i.test(value) && /not|no |weak|不/.test(value)) return 'reproducibility'
  if (/computation|memory|gpu|flops|params|latency|runtime|开销|显存|算力|耗时|内存/.test(value)) return 'resource_infeasible'
  if (/dataset|annotation|label|data (quality|bias)|sampl|数据|标注|样本/.test(value)) return 'data_issue'
  if (/no improvement|not improve|marginal|slightly|degrad|lower|drop|worse|inferior|second best|下降|不升|低于|退化|次优|逊于/.test(value)) return 'metric_not_improved'
  if (/fail|not work|ineffective|cannot|unable|invalid|not able|struggle|失效|无法|不能/.test(value)) return 'method_invalid'
  return 'other'
}

/**
 * 方法名：优先取**论文标题**的前缀（`SFIAD: Deepfake detection…` → `SFIAD`），
 * 否则退化到方法概述的前几个词。
 *
 * 为什么不从 method_summary 切句：英文概述的第一句往往很长（"SFIAD is a frame-level
 * deepfake detection framework consisting of…"），按句号切会得到一段被截断的句子，
 * 让 statement 变得又长又难读（第一版实测就是这个毛病）。
 */
function deriveMethodName(title, summary) {
  const fromTitle = String(title ?? '').split(/[:：—–]\s/)[0]?.trim()
  if (fromTitle !== undefined && fromTitle.length >= 2 && fromTitle.length <= 40 && fromTitle !== String(title ?? '').trim()) {
    return fromTitle
  }
  // 标题里没有分隔符（如 "Continual face forgery detection via historical…"）：
  // 取标题前 4 个词并去掉冠词——比拿方法概述的第一句干净得多
  const titleWords = String(title ?? '').trim().split(/\s+/)
    .filter((word) => !/^(the|a|an|on|towards?|via)$/i.test(word))
    .slice(0, 4)
    .join(' ')
  if (titleWords.length >= 4) return titleWords
  const words = String(summary ?? '').trim().split(/\s+/)
    .filter((word) => !/^(the|a|an|this|we|our|paper)$/i.test(word))
    .slice(0, 4)
    .join(' ')
  return words.length > 0 ? words : '(未命名方法)'
}

/** 把一条局限改写成失败库陈述：保留原意，不改写事实。 */
function toStatement(methodName, limitation) {
  const compact = limitation.replace(/\s+/g, ' ').trim()
  const head = compact.slice(0, 220)
  return `${methodName}：${head}${compact.length > 220 ? '…' : ''}`
}

const dir = 'data/papers/extractions'
const files = (await readdir(dir)).filter((file) => file.endsWith('.json'))
const entries = []
const perMode = {}
for (const file of files) {
  const extraction = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
  const paperId = extraction.paper_id
  const methodName = deriveMethodName(titleById.get(paperId), extraction.method_summary)
  const benchmarks = Array.isArray(extraction.benchmarks) ? extraction.benchmarks.slice(0, 4) : []
  for (const limitation of extraction.limitations ?? []) {
    if (typeof limitation !== 'string' || limitation.trim().length < 12) continue
    const mode = classifyFailureMode(limitation)
    perMode[mode] = (perMode[mode] ?? 0) + 1
    entries.push({
      store: 'failures',
      statement: toStatement(methodName, limitation),
      source_papers: [paperId],
      ext: {
        'deepfake-detection': {
          failure_mode: mode,
          ...(benchmarks.length > 0 ? { conditions: `评测集：${benchmarks.join(' / ')}` } : {}),
          evidence: `paper:${paperId}`,
          // revisit_when 故意留空：这是需要判断的字段，**不编造**
        },
      },
    })
  }
}
db.close()

const selected = limit > 0 ? entries.slice(0, limit) : entries
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(selected, null, 2)}\n`)

console.log(`从 ${files.length} 篇提取的 limitations 派生 ${selected.length} 条失败库种子 → ${OUT}`)
console.log(`失败模式分布：${JSON.stringify(perMode)}`)
console.log('\n样例（前 5 条）：')
for (const entry of selected.slice(0, 5)) {
  console.log(`  [${entry.ext['deepfake-detection'].failure_mode}] ${entry.statement.slice(0, 100)}`)
  console.log(`      source=${entry.source_papers[0]}  conditions=${entry.ext['deepfake-detection'].conditions ?? '(无)'}`)
}
console.log('\n装载：node scripts/load-entries.mjs ' + OUT)
console.log('注意：revisit_when 全部留空——该字段需要判断（失败条件是否已变），不做机械填充。')
