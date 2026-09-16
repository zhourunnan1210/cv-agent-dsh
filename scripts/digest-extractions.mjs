/**
 * 把 21 个提取文件压成**单文件摘要**，供 Analyst 子代理一次读完。
 *
 * 动机（实测）：让子代理逐个 read 21 个 JSON 会陷入「长行被截断 → 再读 → 再截断」
 * 的循环（每个文件要 2–3 次 read，且容易在读取阶段耗尽步数）。摘要把每个文件压成
 * 一个紧凑块，Analyst 只需 1–2 次 read 就能拿到全部事实。
 *
 * 用法：node scripts/digest-extractions.mjs [out.md]
 */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const out = process.argv[2] ?? 'data/papers/digest-for-analyst.md'
const dir = 'data/papers/extractions'
const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()

const db = new PaperDatabase('data/papers/metadata.db')
const meta = new Map(
  db.raw.prepare('SELECT paper_id, title, year, venue FROM papers').all().map((row) => [row.paper_id, row]),
)

const trim = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`)

const lines = [
  '# 21 篇论文的 Reader 提取摘要（P2-7 Analyst 输入）',
  '',
  '来源：`data/papers/extractions/*.json`（20 篇抽检 + 1 篇试点）。以下每个块是一篇论文的',
  '全部结构化提取事实；**原文事实边界以此为准**，不要另行推断。',
  '',
  `共 ${files.length} 篇。`,
  '',
]

for (const file of files) {
  const extraction = JSON.parse(await readFile(join(dir, file), 'utf8'))
  const info = meta.get(extraction.paper_id)
  lines.push(`## ${extraction.paper_id}`)
  lines.push('')
  lines.push(`- 标题：${info?.title ?? '(未在库)'}`)
  lines.push(`- 年份/出处：${info?.year ?? '-'} / ${info?.venue ?? '-'}`)
  lines.push(`- 解决的问题：${trim(extraction.problem_statement, 420)}`)
  lines.push(`- 方法概述：${trim(extraction.method_summary, 650)}`)
  lines.push(`- 创新点（${extraction.innovations.length}）：`)
  for (const item of extraction.innovations) lines.push(`  - ${trim(item, 260)}`)
  lines.push(`- 数据集：${extraction.benchmarks.join(' | ') || '(无)'}`)
  lines.push(`- 指标：${extraction.metrics.join(' | ') || '(无)'}`)
  lines.push(`- 对比方法（${extraction.baseline_methods.length}）：${trim(extraction.baseline_methods.join(' | '), 520) || '(无)'}`)
  lines.push(`- 局限（${extraction.limitations.length}）：${extraction.limitations.length === 0 ? '(原文无)' : ''}`)
  for (const item of extraction.limitations) lines.push(`  - ${trim(item, 200)}`)
  lines.push(`- 未来工作（${extraction.future_work.length}）：${extraction.future_work.length === 0 ? '(原文无)' : ''}`)
  for (const item of extraction.future_work) lines.push(`  - ${trim(item, 200)}`)
  lines.push('')
}

await writeFile(out, lines.join('\n'))
db.close()
console.log(`已写摘要 ${out}（${files.length} 篇，${(lines.join('\n').length / 1024).toFixed(1)}KB）`)
