/**
 * 相似度标定 · 第二轮：用**真值更强**的正例对。
 *
 * 第一轮用「共享来源论文」当正例，结果与负例几乎重合——因为同一篇论文的
 * problem/method/innovation 是**不同陈述**，共享论文不等于语义相似。
 *
 * 这一轮用真正的「同内容、不同措辞」对：
 *   - 正例：三库 innovations 条目 ↔ 其来源论文的 Reader 提取里的创新点原文
 *     （Analyst 正是从那些创新点改写出条目的，属天然的 paraphrase 对）；
 *   - 负例：条目 ↔ 随机另一篇论文的提取文本（关键词重叠少）。
 *
 * 输出：两组的分数分布 → keyword_only 模式下「同内容」的可判区间。
 */

import { readFile, readdir } from 'node:fs/promises'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { lexicalSimilarity } from '../packages/core/lib/index.js'

const db = new PaperDatabase('data/papers/metadata.db')
const dir = 'data/papers/extractions'
const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
const extractionByPaper = new Map()
for (const file of files) {
  const extraction = JSON.parse(await readFile(`${dir}/${file}`, 'utf8'))
  extractionByPaper.set(extraction.paper_id, extraction)
}

const entries = db.raw
  .prepare("SELECT entry_id, statement, source_papers FROM innovations")
  .all()
  .map((row) => ({ ...row, sources: JSON.parse(row.source_papers) }))

const positives = []
const negatives = []
const perEntry = []
for (const entry of entries) {
  // 正例：该条目来源论文的提取创新点（取最大相似度 = "它改写自哪一条"）
  const ownTexts = entry.sources
    .map((paperId) => extractionByPaper.get(paperId))
    .filter((extraction) => extraction !== undefined)
    .flatMap((extraction) => extraction.innovations)
  if (ownTexts.length === 0) continue
  const ownMax = Math.max(...ownTexts.map((text) => lexicalSimilarity(entry.statement, text)))
  positives.push(ownMax)

  // 负例：其它论文的提取创新点（取最大，模拟"检索到的别的论文"）
  const otherTexts = [...extractionByPaper.entries()]
    .filter(([paperId]) => !entry.sources.includes(paperId))
    .flatMap(([, extraction]) => extraction.innovations)
  const otherMax = otherTexts.length === 0
    ? 0
    : Math.max(...otherTexts.map((text) => lexicalSimilarity(entry.statement, text)))
  negatives.push(otherMax)
  perEntry.push({ entry_id: entry.entry_id, own: Math.round(ownMax * 1000) / 1000, other: Math.round(otherMax * 1000) / 1000 })
}

const sorted = (values) => [...values].sort((a, b) => a - b)
const q = (values, p) => {
  const list = sorted(values)
  if (list.length === 0) return 0
  return list[Math.min(list.length - 1, Math.max(0, Math.round((p / 100) * (list.length - 1))))]
}

console.log(`正例（条目 ↔ 其来源论文的创新点原文）：n=${positives.length}`)
console.log(`  p10=${q(positives, 10)} p25=${q(positives, 25)} p50=${q(positives, 50)} p75=${q(positives, 75)} p90=${q(positives, 90)} max=${q(positives, 100)}`)
console.log(`负例（条目 ↔ 其它论文的创新点）：n=${negatives.length}`)
console.log(`  p50=${q(negatives, 50)} p75=${q(negatives, 75)} p90=${q(negatives, 90)} p95=${q(negatives, 95)} p99=${q(negatives, 99)} max=${q(negatives, 100)}`)

const overlapAt = (threshold) => {
  const tp = positives.filter((value) => value >= threshold).length
  const fp = negatives.filter((value) => value >= threshold).length
  return { threshold, recall: Math.round((tp / positives.length) * 100), false_positive: fp }
}
console.log('\n阈值扫描（命中数）：')
for (const threshold of [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]) {
  const row = overlapAt(threshold)
  console.log(`  ≥${threshold}：正例命中 ${row.recall}%（${positives.filter((v) => v >= threshold).length}/${positives.length}），负例误报 ${row.false_positive}/${negatives.length}`)
}

console.log('\n逐条明细（own = 与来源论文创新点的最大相似度，other = 与其它论文的最大相似度）：')
perEntry.sort((a, b) => b.own - a.own)
for (const row of perEntry.slice(0, 12)) console.log(`  ${row.entry_id}  own=${row.own}  other=${row.other}`)
console.log('  …')
for (const row of perEntry.slice(-6)) console.log(`  ${row.entry_id}  own=${row.own}  other=${row.other}`)

db.close()
