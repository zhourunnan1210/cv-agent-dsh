/**
 * 回填三库条目的 `related_problem_ids` / `related_method_ids`（ext 里的关系字段）。
 *
 * 为什么需要回填：Analyst 生成时 ID 还不存在（ID 由入库时分配），所以那两栏只能是
 * 空数组。入库后可以**机械且可验证**地补上：按 `source_papers` 求交集——
 * innovations/methods 若与某 problem 共享论文，就建立关联。
 *
 * 用法：node scripts/link-entry-ids.mjs [--dry-run]
 */

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const dryRun = process.argv.includes('--dry-run')
const db = new PaperDatabase('data/papers/metadata.db')

const rows = []
for (const store of ['problems', 'methods', 'innovations']) {
  for (const row of db.raw.prepare(`SELECT entry_id, source_papers, ext FROM ${store}`).all()) {
    rows.push({ store, entry_id: row.entry_id, sources: JSON.parse(row.source_papers), ext: JSON.parse(row.ext) })
  }
}
const problems = rows.filter((row) => row.store === 'problems')
const methods = rows.filter((row) => row.store === 'methods')
const share = (a, b) => a.some((id) => b.includes(id))

let updated = 0
for (const row of rows) {
  if (row.store === 'problems') continue
  const relatedProblems = problems.filter((problem) => share(row.sources, problem.sources)).map((problem) => problem.entry_id)
  const relatedMethods = row.store === 'innovations'
    ? methods.filter((method) => share(row.sources, method.sources)).map((method) => method.entry_id)
    : []
  const pack = row.ext['deepfake-detection'] ?? {}
  const nextPack = {
    ...pack,
    ...(relatedProblems.length === 0 ? {} : { related_problem_ids: relatedProblems }),
    ...(row.store === 'innovations' && relatedMethods.length > 0 ? { related_method_ids: relatedMethods } : {}),
  }
  const before = JSON.stringify(pack)
  const after = JSON.stringify(nextPack)
  if (before === after) continue
  updated += 1
  if (!dryRun) {
    const store = row.store
    db.raw
      .prepare(`UPDATE ${store} SET ext = ?, updated_at = ? WHERE entry_id = ?`)
      .run(JSON.stringify({ ...row.ext, 'deepfake-detection': nextPack }), new Date().toISOString(), row.entry_id)
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}${row.entry_id} [${row.store}] problems=${relatedProblems.join(',') || '-'} methods=${relatedMethods.join(',') || '-'}`)
}

console.log(`\n${dryRun ? 'DRY RUN' : 'LINK OK'} —— 回填 ${updated} 条`)
const counts = {}
for (const store of ['problems', 'methods', 'innovations']) {
  counts[store] = db.raw.prepare(`SELECT COUNT(*) c FROM ${store}`).get().c
}
console.log('三库计数：', JSON.stringify(counts), '合计', Object.values(counts).reduce((a, b) => a + b, 0))
db.close()
