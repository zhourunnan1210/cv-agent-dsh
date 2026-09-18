// 生成本地 MinerU 的待解析 PDF 清单（供 scripts/_mineru_local_shim.py --list 使用）
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const database = new PaperDatabase('data/papers/metadata.db')

const rows = database.raw.prepare(`
  SELECT paper_id, pdf_path, year FROM papers
  WHERE (parse_channel IS NULL OR parse_channel = '')
    AND pdf_path IS NOT NULL AND pdf_path != ''
  ORDER BY year DESC, paper_id ASC
`).all()

const items = rows.map((row) => ({
  paper_id: row.paper_id,
  pdf: resolve(row.pdf_path),
}))

await writeFile('data/papers/localmineru-list.txt', `${items.map((i) => i.pdf).join('\n')}\n`)
await writeFile('data/papers/localmineru-map.json', `${JSON.stringify({ generated_at: new Date().toISOString(), count: items.length, items }, null, 2)}\n`)

console.log(`待本地解析：${items.length} 篇`)
console.log('  PDF 清单：data/papers/localmineru-list.txt')
console.log('  paper_id 映射：data/papers/localmineru-map.json')
database.close()
