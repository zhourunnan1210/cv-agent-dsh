/**
 * Analyst 三库条目入库：node scripts/save-entries.mjs <entries-json-path>
 * JSON 为数组：[{ store, statement, source_papers, ext }]。
 */
import { readFile } from 'node:fs/promises'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { TriLibrary } from '../packages/dsh-plugin/lib/kb/trilibrary.js'

const path = process.argv[2]
if (!path) {
  console.error('用法：node scripts/save-entries.mjs <entries-json-path>')
  process.exit(2)
}
const entries = JSON.parse(await readFile(path, 'utf8'))
const sourcePaper = process.argv[3] ?? '10.48550/arxiv.2508.20449'

const database = new PaperDatabase('data/papers/metadata.db')
const tri = new TriLibrary(database)
for (const entry of entries) {
  const outcome = tri.upsert(entry.store, entry.statement, entry.source_papers ?? [sourcePaper], entry.ext ?? {})
  console.log(`${outcome.merged ? '合并' : '新建'} ${outcome.entry_id} [${entry.store}] ${entry.statement.slice(0, 50)}`)
}
console.log('三库计数：', JSON.stringify(tri.counts()))
database.close()
