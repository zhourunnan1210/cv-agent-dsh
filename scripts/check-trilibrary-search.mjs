/**
 * 迁移 v4 在**生产库**上的实测：FTS5 索引重建 + 三库检索可用性。
 * 只读为主（迁移本身会写 schema 与索引，属预期）。
 */
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { TriLibrary } from '../packages/dsh-plugin/lib/kb/trilibrary.js'

const db = new PaperDatabase('data/papers/metadata.db')
console.log('已应用迁移：', db.appliedMigrations().join(', '))
const tri = new TriLibrary(db)
const summary = tri.summary()
console.log('三库计数：', JSON.stringify(summary.counts), '合计', summary.total)
console.log('最近更新：', summary.latest_updated_at)

const probes = [
  { label: '中文 3 字（FTS5 trigram）', options: { query: '灾难性遗忘' } },
  { label: '中文 2 字（LIKE 回退）', options: { query: '泛化' } },
  { label: '英文（FTS5，大小写不敏感）', options: { query: 'clip' } },
  { label: '方法名', options: { query: 'SFMFNet' } },
  { label: '限定 methods', options: { store: 'methods', limit: 3 } },
]
for (const probe of probes) {
  const hits = tri.search({ ...probe.options, limit: 3 })
  console.log(`\n[${probe.label}] ${JSON.stringify(probe.options)} → ${hits.length} 条`)
  for (const hit of hits) console.log(`  ${hit.entry_id} [${hit.store}] ${hit.statement.slice(0, 72)}`)
}

// 索引与基表一致性：三张 FTS 表的行数必须等于基表行数
for (const store of ['problems', 'methods', 'innovations']) {
  const base = db.raw.prepare(`SELECT COUNT(*) c FROM ${store}`).get().c
  const fts = db.raw.prepare(`SELECT COUNT(*) c FROM ${store}_fts`).get().c
  console.log(`${store}: base=${base} fts=${fts} ${base === fts ? '✅' : '❌ 不一致'}`)
}
db.close()
