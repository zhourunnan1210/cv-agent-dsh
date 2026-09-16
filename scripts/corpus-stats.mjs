import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const db = new PaperDatabase('data/papers/metadata.db')
const rows = db.raw
  .prepare("SELECT title FROM papers WHERE lower(title) LIKE '%audio%' OR lower(title) LIKE '%voice%' OR lower(title) LIKE '%speech%'")
  .all()
console.log('audio/voice/speech:', rows.length)
for (const r of rows.slice(0, 12)) console.log(' -', String(r.title).slice(0, 90))
console.log('total papers:', db.raw.prepare('SELECT COUNT(*) c FROM papers').get().c)
const parsed = db.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru'").get().c
console.log('parsed(mineru):', parsed)
db.close()
