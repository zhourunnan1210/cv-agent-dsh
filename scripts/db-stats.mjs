import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { readFile } from 'node:fs/promises'

const db = new PaperDatabase('data/papers/metadata.db')
const total = db.raw.prepare('SELECT COUNT(*) c FROM papers').get().c
const parsed = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru'").get().c
const failed = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'failed'").get().c
const pending = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel IS NULL OR parse_channel = ''").get().c
console.log(`papers=${total} parsed=${parsed} failed=${failed} unparsed=${pending}`)
const channels = db.raw.prepare('SELECT source_channel, COUNT(*) c FROM papers GROUP BY source_channel').all()
console.log('channels:', JSON.stringify(channels))
const byId = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE doi IS NOT NULL OR arxiv_id IS NOT NULL").get().c
console.log(`with external id: ${byId}`)
const ex = db.raw.prepare('SELECT COUNT(*) c FROM paper_extractions').get().c
console.log(`extractions=${ex}`)
const tri = ['problems', 'methods', 'innovations'].map((t) => `${t}=${db.raw.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`).join(' ')
console.log('trilibrary:', tri)
try {
  const state = JSON.parse(await readFile('data/papers/batch-state.json', 'utf8'))
  const counts = {}
  for (const c of state.chunks) counts[c.status] = (counts[c.status] ?? 0) + 1
  console.log('batch-state chunks:', JSON.stringify(counts), 'total items:', state.chunks.reduce((s, c) => s + c.items.length, 0))
} catch (error) {
  console.log('batch-state: 读取失败', error.message)
}
db.close()
