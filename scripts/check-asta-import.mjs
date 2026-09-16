/** Asta 控制组导入质量核查：主题相关性抽样 + 标题重复检查。 */
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { normalizeTitle } from '../packages/core/lib/index.js'

const db = new PaperDatabase('data/papers/metadata.db')
const asta = db.raw.prepare("SELECT paper_id, title, year, venue, doi, arxiv_id FROM papers WHERE source_channel = 'asta' ORDER BY year DESC").all()
console.log(`asta 通道：${asta.length} 条`)
console.log('\n最近 8 条（年份降序）：')
for (const row of asta.slice(0, 8)) console.log(`  ${row.year ?? '-'}  ${String(row.title).slice(0, 88)}`)

const byNorm = new Map()
let dupGroups = 0
let dupRows = 0
for (const row of asta) {
  const key = normalizeTitle(row.title)
  if (!byNorm.has(key)) byNorm.set(key, [])
  byNorm.get(key).push(row)
}
for (const [, group] of byNorm) {
  if (group.length > 1) {
    dupGroups += 1
    dupRows += group.length
    console.log(`\n⚠ 归一化标题重复（${group.length} 条）：${group[0].title.slice(0, 70)}`)
    for (const row of group) console.log(`    ${row.paper_id}`)
  }
}
console.log(`\n归一化标题重复组：${dupGroups}（涉及 ${dupRows} 条）`)

const audioKeywords = /audio|voice|speech|spoof|asv|anti-?spoof|deepfake|synthetic/i
const onTopic = asta.filter((row) => audioKeywords.test(String(row.title))).length
console.log(`标题含音频/深伪关键词：${onTopic}/${asta.length}`)
const withDoi = asta.filter((row) => row.doi !== null && row.doi !== undefined && row.doi !== '').length
const withArxiv = asta.filter((row) => row.arxiv_id !== null && row.arxiv_id !== undefined && row.arxiv_id !== '').length
console.log(`有 DOI：${withDoi}，有 arXiv：${withArxiv}`)
const pdfPending = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE source_channel = 'asta' AND pdf_status = 'pending'").get().c
console.log(`pdf_status='pending'：${pdfPending}`)
db.close()
