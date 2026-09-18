// 建立「PDF 主文件名 → paper_id」映射，供本地 MinerU 产出回接我们库里时对账
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/papers/metadata.db', { readOnly: true })
const rows = db.prepare(`
  SELECT paper_id, pdf_path, year FROM papers
  WHERE (parse_channel IS NULL OR parse_channel = '')
    AND pdf_path IS NOT NULL AND pdf_path != ''
  ORDER BY year DESC, paper_id ASC
`).all()

const items = rows.map((row) => {
  const pdfPath = String(row.pdf_path)
  const fileName = pdfPath.split(/[\\/]/).pop()
  return {
    paper_id: row.paper_id,
    pdf_file: fileName,
    stem: fileName.replace(/\.pdf$/i, ''),
    pdf_path: pdfPath,
  }
})

writeFileSync('data/papers/localmineru-map.json', `${JSON.stringify({
  generated_at: new Date().toISOString(),
  count: items.length,
  note: '本地 MinerU 产出落盘为 <stem>/，回接时用 stem 对齐 paper_id',
  items,
}, null, 2)}\n`)

console.log(`映射条数：${items.length}`)
console.log('首条：', JSON.stringify(items[0]))
console.log('末条：', JSON.stringify(items[items.length - 1]))
db.close()
