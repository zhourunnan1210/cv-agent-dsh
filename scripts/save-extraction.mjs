/**
 * Reader 提取结果入库：node scripts/save-extraction.mjs <extraction-json-path>
 * 提取 JSON 形如 core 的 PaperExtraction（papers/extractions/ 下的文件）。
 */
import { readFile } from 'node:fs/promises'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'

const path = process.argv[2]
if (!path) {
  console.error('用法：node scripts/save-extraction.mjs <extraction-json-path>')
  process.exit(2)
}
const extraction = JSON.parse(await readFile(path, 'utf8'))
const database = new PaperDatabase('data/papers/metadata.db')
const library = new PaperLibrary(database)
library.saveExtraction(extraction)
console.log(`已保存提取：${extraction.paper_id}（${extraction.extraction_quality}，提取于 ${extraction.extracted_at}）`)
console.log(`提取总数：${library.extractionCount()}`)
database.close()
