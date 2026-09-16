/**
 * 续跑：查询既有 batch 的最终状态，下载解压并落库（不重复提交、不重复计费）。
 * 用法：node scripts/resume-batch.mjs <batch_id> <paper_id> [pages]
 */
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { MineruClient } from '../packages/dsh-plugin/lib/kb/mineru.js'
import { MineruQuotaLedger } from '../packages/dsh-plugin/lib/kb/mineru-quota.js'

const batchId = process.argv[2]
const paperId = process.argv[3]
const pages = Number(process.argv[4] ?? 0)
if (!batchId || !paperId) {
  console.error('用法：node scripts/resume-batch.mjs <batch_id> <paper_id> [pages]')
  process.exit(2)
}

try {
  const dotEnv = await readFile('.env.local', 'utf8')
  for (const rawLine of dotEnv.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '' && !process.env[key]) process.env[key] = value
  }
} catch {
  // 靠环境
}

const client = new MineruClient({
  baseUrl: 'https://mineru.net/api/v4',
  resolveToken: async () => process.env.MINERU_TOKEN,
  pollIntervalMs: 8000,
  pollTimeoutMs: 15 * 60 * 1000,
})

const result = await client.pollBatch(batchId, AbortSignal.timeout(15 * 60 * 1000))
const file = result.files[0]
if (file === undefined || file.state !== 'done' || file.fullZipUrl === undefined) {
  console.error(`解析未成功：${JSON.stringify(file)}`)
  process.exit(3)
}

const markdownDir = resolve('data/papers/markdown', paperId)
const written = await client.downloadExtract(file.fullZipUrl, markdownDir)
console.log(`解压 ${written.length} 个文件到 ${markdownDir}`)

const database = new PaperDatabase('data/papers/metadata.db')
const now = new Date().toISOString()
database.raw
  .prepare("UPDATE papers SET parse_channel = 'mineru', md_path = ?, updated_at = ? WHERE paper_id = ?")
  .run(`markdown/${paperId}/full.md`, now, paperId)

if (pages > 0) {
  const quota = new MineruQuotaLedger(resolve('data/mineru-quota.json'))
  await quota.load()
  const quotaStatus = await quota.record(pages)
  console.log(`额度记账：+${pages} 页 → 今日已用 ${quotaStatus.usedPages}/${quotaStatus.limit}`)
}

database.close()
console.log('RESUME BATCH OK')
