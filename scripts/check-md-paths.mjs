/** md_path 完整性核查：库里每条 md_path 是否真实存在且非空。 */
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const db = new PaperDatabase('data/papers/metadata.db')
const rows = db.raw
  .prepare("SELECT paper_id, md_path, parse_channel FROM papers WHERE md_path IS NOT NULL AND md_path != ''")
  .all()
let ok = 0
const missing = []
const empty = []
for (const row of rows) {
  const absolute = resolve('data/papers', row.md_path)
  try {
    const info = statSync(absolute)
    if (info.size < 1024) empty.push(`${row.paper_id} (${info.size}B)`)
    else ok += 1
  } catch {
    missing.push(`${row.paper_id} → ${row.md_path}`)
  }
}
const parsed = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru'").get().c
console.log(`parse_channel='mineru'：${parsed}；md_path 非空：${rows.length}`)
console.log(`可读且 ≥1KB：${ok}；缺失：${missing.length}；过小：${empty.length}`)
for (const item of missing) console.log('  ✗ 缺失', item)
for (const item of empty) console.log('  ⚠ 过小', item)
const noMd = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru' AND (md_path IS NULL OR md_path = '')").get().c
console.log(`mineru 但无 md_path：${noMd}`)
db.close()
