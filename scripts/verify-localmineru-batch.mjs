// 本地 MinerU 批次质量核查：产出大小分布 + 异常件 + 数据库一致性
import { readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('data/papers/metadata.db', { readOnly: true })
const rows = (await readFile('data/papers/markdown-local/manifest.jsonl', 'utf8'))
  .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))

console.log(`批次 ${rows.length} 篇\n`)

const sizes = []
const suspicious = []
let dbOk = 0
let missing = 0

for (const row of rows) {
  const paperId = row.stem.replace(/_/g, '/')
  const record = db.prepare('SELECT md_path, parse_channel FROM papers WHERE paper_id = ?').get(paperId)
  if (record === undefined || !record.md_path) {
    missing += 1
    continue
  }
  dbOk += 1
  const abs = `data/papers/${record.md_path}`
  const info = await stat(abs).catch(() => undefined)
  if (info === undefined) {
    suspicious.push({ paperId, why: 'md_path 指向的文件不存在' })
    continue
  }
  const text = await readFile(abs, 'utf8')
  sizes.push({ paperId, kb: info.size / 1024, chars: text.length, headings: (text.match(/^#{1,6}\s/gm) ?? []).length })
  if (info.size < 5000 || text.length < 3000) {
    suspicious.push({ paperId, why: `产出过小（${Math.round(info.size / 1024)}KB / ${text.length} 字符）` })
  }
}

sizes.sort((a, b) => a.chars - b.chars)

console.log('=== 产出规模分布 ===')
const kb = sizes.map((s) => s.kb)
const avg = kb.reduce((a, b) => a + b, 0) / (kb.length || 1)
console.log(`  篇数 ${sizes.length}；平均 ${avg.toFixed(1)} KB；最小 ${kb[0]?.toFixed(1)} KB；最大 ${kb[kb.length - 1]?.toFixed(1)} KB`)
console.log(`  中位数 ${kb[Math.floor(kb.length / 2)]?.toFixed(1)} KB`)
console.log(`  含标题的篇数：${sizes.filter((s) => s.headings > 0).length}/${sizes.length}`)

console.log('\n=== 最小的 5 篇（人工扫一眼是否残缺）===')
for (const s of sizes.slice(0, 5)) console.log(`  ${s.paperId}  ${s.kb.toFixed(1)}KB  ${s.chars} 字符  ${s.headings} 标题`)

console.log('\n=== 最大的 3 篇 ===')
for (const s of sizes.slice(-3)) console.log(`  ${s.paperId}  ${s.kb.toFixed(1)}KB  ${s.chars} 字符  ${s.headings} 标题`)

console.log('\n=== 异常件 ===')
if (suspicious.length === 0) console.log('  （无）')
for (const s of suspicious) console.log(`  ⚠ ${s.paperId}  ← ${s.why}`)

console.log(`\n=== 数据库一致性 ===`)
console.log(`  库里有 md_path：${dbOk}/${rows.length}`)
console.log(`  库记录缺失：${missing}`)
const total = db.prepare("SELECT COUNT(*) c FROM papers WHERE md_path IS NOT NULL AND md_path != ''").get().c
const local = db.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru-local'").get().c
const pending = db.prepare("SELECT COUNT(*) c FROM papers WHERE (parse_channel IS NULL OR parse_channel = '') AND pdf_path IS NOT NULL AND pdf_path != ''").get().c
console.log(`  全库已解析 ${total}（本地 MinerU ${local}）`)
console.log(`  仍待解析 ${pending}`)
db.close()
