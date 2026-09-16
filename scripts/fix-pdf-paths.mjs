/** 把磁盘上不存在的 pdf_path 清空（重导入时按磁盘实测校正回填）。 */
import { existsSync } from 'node:fs'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const db = new PaperDatabase('data/papers/metadata.db')
const rows = db.raw.prepare('SELECT paper_id, pdf_path FROM papers WHERE pdf_path IS NOT NULL').all()
let broken = 0
for (const row of rows) {
  if (!existsSync(row.pdf_path)) {
    db.raw.prepare('UPDATE papers SET pdf_path = NULL WHERE paper_id = ?').run(row.paper_id)
    broken += 1
    console.log(`清空：${row.paper_id} ← ${row.pdf_path}`)
  }
}
console.log(`共 ${rows.length} 行有 pdf_path，其中 ${broken} 行路径失效已清空`)
db.close()
