/** 导出三库现有条目（Analyst 去重用）：node scripts/export-entries.mjs [out.json] */
import { writeFile } from 'node:fs/promises'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const out = process.argv[2] ?? 'data/papers/existing-entries.json'
const db = new PaperDatabase('data/papers/metadata.db')
const rows = []
for (const store of ['problems', 'methods', 'innovations']) {
  for (const row of db.raw.prepare(`SELECT entry_id, statement, source_papers FROM ${store} ORDER BY entry_id`).all()) {
    rows.push({ store, entry_id: row.entry_id, statement: row.statement, source_papers: JSON.parse(row.source_papers) })
  }
}
await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`)
console.log(`导出 ${rows.length} 条既有条目 → ${out}`)
for (const row of rows) console.log(`  ${row.entry_id} [${row.store}] ${row.statement.slice(0, 70)}`)
db.close()
