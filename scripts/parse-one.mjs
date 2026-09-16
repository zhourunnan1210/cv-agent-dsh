/**
 * P2-6 · 单篇真实 PDF 的 MinerU 全链路解析（上传优先 + 轮询 + 解压 + 额度记账）。
 *
 * 用法：node scripts/parse-one.mjs <paper_id>
 *
 * 前置：MINERU_TOKEN（.env.local 或环境）。mineru.net 国内直连，不走代理。
 * 额度：真实消耗解析页数（记入 data/mineru-quota.json，2000 页/天账本）。
 */

import { basename, join, resolve } from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { MineruClient } from '../packages/dsh-plugin/lib/kb/mineru.js'
import { MineruQuotaLedger } from '../packages/dsh-plugin/lib/kb/mineru-quota.js'

const paperId = process.argv[2]
if (!paperId) {
  console.error('用法：node scripts/parse-one.mjs <paper_id>')
  process.exit(2)
}

// ── 环境（.env.local 读取；已存在的环境变量优先）────────────────────────
try {
  const dotEnv = await readFile('.env.local', 'utf8')
  for (const rawLine of dotEnv.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '' && !process.env[key]) process.env[key] = value
  }
} catch {
  // 无 .env.local 时靠环境
}

const database = new PaperDatabase('data/papers/metadata.db')
const row = database.raw.prepare('SELECT * FROM papers WHERE paper_id = ?').get(paperId)
if (!row) {
  console.error(`论文不存在：${paperId}`)
  database.close()
  process.exit(2)
}
if (!row.pdf_path) {
  console.error(`该论文没有本地 PDF 路径（pdf_path 为空）：${paperId}`)
  database.close()
  process.exit(2)
}

const pdfPath = row.pdf_path
const pdfName = basename(pdfPath)
console.log(`解析目标：${row.title}`)
console.log(`本地文件：${pdfPath}`)

// ── 本地页数（pdf-parse，走 vendored 包的依赖解析，不新增依赖）────────────
const requireVendor = createRequire('D:/Code/VScodeRepo/dsh-plugin/packages/vendor/dsh-ai4scholar/package.json')
const pdfParseEntry = requireVendor.resolve('pdf-parse')
// pdf-parse v2：PDFParse 是类（与 vendored 包 extractPdfText 的用法一致）
const { PDFParse } = await import(pathToFileURL(pdfParseEntry).href)
const pdfBytes = await readFile(pdfPath)
const pdf = new PDFParse({ data: pdfBytes })
let pages = 1
try {
  const result = await pdf.getText()
  pages = Number(result.total) || 1
} finally {
  await pdf.destroy()
}
console.log(`本地页数：${pages}`)

// ── MinerU 全链路 ─────────────────────────────────────────────────────────
const client = new MineruClient({
  baseUrl: 'https://mineru.net/api/v4',
  resolveToken: async () => process.env.MINERU_TOKEN,
  pollIntervalMs: 8000,
  pollTimeoutMs: 15 * 60 * 1000,
})

const batchId = await client.submitLocalFiles([{ name: pdfName, path: pdfPath, data_id: paperId }])
console.log(`batch_id: ${batchId}`)

const result = await client.pollBatch(batchId, AbortSignal.timeout(15 * 60 * 1000))
const file = result.files[0]
if (file === undefined || file.state !== 'done' || file.fullZipUrl === undefined) {
  console.error(`解析未成功：${JSON.stringify(file)}`)
  database.close()
  process.exit(3)
}

const markdownDir = resolve('data/papers/markdown', paperId)
const written = await client.downloadExtract(file.fullZipUrl, markdownDir)
console.log(`解压 ${written.length} 个文件到 ${markdownDir}`)
for (const path of written) console.log(`  ${path.replace(resolve('data/papers'), 'data/papers')}`)

// ── 落库 + 记账 ───────────────────────────────────────────────────────────
const now = new Date().toISOString()
database.raw
  .prepare("UPDATE papers SET parse_channel = 'mineru', md_path = ?, updated_at = ? WHERE paper_id = ?")
  .run(`markdown/${paperId}/full.md`, now, paperId)

const quota = new MineruQuotaLedger(resolve('data/mineru-quota.json'))
await quota.load()
const quotaStatus = await quota.record(pages)
console.log(`额度记账：+${pages} 页 → 今日已用 ${quotaStatus.usedPages}/${quotaStatus.limit}${quotaStatus.warning ? '（已达告警阈值）' : ''}`)

database.close()
console.log('PARSE ONE OK')
