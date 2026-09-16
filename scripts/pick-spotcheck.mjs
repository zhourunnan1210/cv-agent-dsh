/**
 * P2-7 · 抽检抽样器：从已解析论文里挑一个**有代表性**的 20 篇名单。
 *
 * 用法：node scripts/pick-spotcheck.mjs [--n 20] [--min-kb 20]
 *
 * 抽样规则（避免只看好解析的样本，掩盖真实失败模式）：
 *   - 只在 parse_channel='mineru' 且 full.md 实际存在、且体积 ≥ min-kb 的论文里选；
 *   - 分层：arXiv（10.48550/* 或纯 arxiv id）/ DOI 出版商 / local: 本地条目 三档
 *     各自尽量均分；
 *   - 每档内按「年份新 → 旧」交替，覆盖新老论文；
 *   - 排除已有提取的论文（不重复抽检）。
 *
 * 输出：data/papers/spotcheck-plan.json（含 paper_id/title/md_path/档位/体积）。
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback
}
const N = opt('--n', 20)
const MIN_KB = opt('--min-kb', 20)

const database = new PaperDatabase('data/papers/metadata.db')
const extracted = new Set(database.raw.prepare('SELECT paper_id FROM paper_extractions').all().map((r) => r.paper_id))
const rows = database.raw
  .prepare(`
    SELECT paper_id, title, md_path, year, venue, doi, arxiv_id, source_channel
    FROM papers
    WHERE parse_channel = 'mineru' AND md_path IS NOT NULL AND md_path != ''
    ORDER BY year DESC, paper_id ASC
  `)
  .all()

const tierOf = (row) => {
  if (row.paper_id.startsWith('local:')) return 'local'
  if (row.arxiv_id !== null && row.arxiv_id !== undefined) return 'arxiv'
  if (String(row.paper_id).startsWith('10.48550/')) return 'arxiv'
  return 'doi'
}

const candidates = { arxiv: [], doi: [], local: [] }
for (const row of rows) {
  if (extracted.has(row.paper_id)) continue
  const absolute = resolve('data/papers', row.md_path)
  let size = 0
  try {
    size = (await stat(absolute)).size
  } catch {
    console.warn(`⚠ full.md 缺失：${row.paper_id}（${row.md_path}）`)
    continue
  }
  if (size < MIN_KB * 1024) {
    console.warn(`⚠ 过小跳过：${row.paper_id}（${Math.round(size / 1024)}KB < ${MIN_KB}KB）`)
    continue
  }
  candidates[tierOf(row)].push({ ...row, sizeKb: Math.round(size / 1024) })
}

// 分层均分：先各取一轮，再按剩余补齐
const picked = []
const tiers = ['arxiv', 'doi', 'local']
let round = 0
while (picked.length < N && round < 100) {
  let progressed = false
  for (const tier of tiers) {
    if (picked.length >= N) break
    const item = candidates[tier][round]
    if (item === undefined) continue
    picked.push({ ...item, tier })
    progressed = true
  }
  if (!progressed) break
  round += 1
}

const plan = {
  generated_at: new Date().toISOString(),
  requirement: `抽检 ${N} 篇（min ${MIN_KB}KB），分层 arxiv/doi/local`,
  counts: { parsed: rows.length, extracted: extracted.size, candidates: Object.fromEntries(tiers.map((t) => [t, candidates[t].length])) },
  papers: picked.map((p) => ({ paper_id: p.paper_id, title: p.title, md_path: p.md_path, year: p.year, venue: p.venue, tier: p.tier, sizeKb: p.sizeKb })),
}
await writeFile('data/papers/spotcheck-plan.json', `${JSON.stringify(plan, null, 2)}\n`)
database.close()

console.log(`已解析 ${rows.length} 篇，已提取 ${extracted.size} 篇；候选：arxiv ${candidates.arxiv.length}、doi ${candidates.doi.length}、local ${candidates.local.length}`)
console.log(`抽样 ${picked.length} 篇 → data/papers/spotcheck-plan.json\n`)
for (const p of plan.papers) console.log(`  [${p.tier}] ${p.paper_id}  ${p.sizeKb}KB  ${String(p.title).slice(0, 70)}`)
