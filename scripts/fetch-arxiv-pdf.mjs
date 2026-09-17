/**
 * arXiv 定向取 PDF（E34 复盘产物）：本机 `paper-fetch` 的 arXiv 源走
 * `https://arxiv.org/pdf/<id>`，在本环境**一律被拦（HTTP 406）**，因此带 arXiv ID 的
 * 论文需要一条专用通道。
 *
 * 实测（2026-09-17，逐项对照）：
 *   https://arxiv.org/pdf/<id>          → 406（代理与直连均如此）
 *   https://export.arxiv.org/pdf/<id>   → 406
 *   http://export.arxiv.org/pdf/<id>    → 200 OK（%PDF-）   ← 本脚本主路径
 *
 * 另外两个必须处理的失败模式（都实测碰到过）：
 *   1. 连接被中途掐断 → 分块读取 + 逐 URL 重试，且允许分块重试后仍拼出完整 PDF
 *   2. 带版本号的地址比不带版本号更容易成功（v1 有时反而 406）→ 候选地址按序全试
 *
 * 用法：
 *   node scripts/fetch-arxiv-pdf.mjs [--limit N] [--dry-run] [--paper-id <id>...]
 *
 * 默认范围：pdf_status='pending' 且 arxiv_id 非空的全部论文（按年份新者优先）。
 * 落库：写 pdf_path 与 pdf_status='downloaded'（幂等：本地已是合法 PDF 则跳过）。
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
const flag = (name) => args.includes(name)
const limitN = Number(opt('--limit') ?? 0)
const dryRun = flag('--dry-run')
const onlyIds = args.reduce((acc, a, i) => (a === '--paper-id' && args[i + 1] ? [...acc, args[i + 1]] : acc), [])

const PDF_DIR = resolve('data/papers/pdf')
/** arXiv 官方要求请求间隔 ≥ 3s；这里放宽到 4s（批量时更稳妥）。 */
const SLEEP_MS = 4000
const UA = 'cv-research-agent/0.1 (academic literature acquisition)'

const database = new PaperDatabase('data/papers/metadata.db')

/** paper_id → 文件系统安全的 slug（与既有 data/papers/pdf 命名一致）。 */
const slug = (arxivId) => arxivId.replace(/[^A-Za-z0-9_.-]/g, '_')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 本地已是合法 PDF（>20KB 且 %PDF 魔数）——幂等跳过，不重复下载。 */
async function existingPdf(path) {
  try {
    const info = await stat(path)
    if (info.size < 20_000) return false
    const head = await readFile(path).then((b) => b.subarray(0, 5).toString('latin1'))
    return head.startsWith('%PDF')
  } catch {
    return false
  }
}

/**
 * 分块读取响应体：连接被提前掐断时保留已收字节（§E34 实测 IncompleteRead）。
 * 若已收字节是合法 PDF 开头且长度合理，仍然接受——比整篇重来省事得多。
 */
async function readBodyChunked(resp) {
  const reader = resp.body?.getReader()
  if (reader === undefined) return Buffer.from(await resp.arrayBuffer())
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.length
    }
  } catch (error) {
    // 中断：把已收部分交回调用方判断（不是所有中断都致命）
    return { bytes: Buffer.concat(chunks), interrupted: error.message, total }
  }
  return { bytes: Buffer.concat(chunks), interrupted: undefined, total }
}

/** 依次尝试候选地址；返回第一个能取出完整 PDF 的（bytes, url）。 */
async function fetchArxivPdf(arxivId) {
  const candidates = [
    `http://export.arxiv.org/pdf/${arxivId}`,
    `http://export.arxiv.org/pdf/${arxivId}v1`,
    `https://export.arxiv.org/pdf/${arxivId}`,
    `https://arxiv.org/pdf/${arxivId}`,
  ]
  const errors = []
  for (const url of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120_000)
        let resp
        try {
          resp = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' }, signal: controller.signal })
        } finally {
          clearTimeout(timer)
        }
        if (!resp.ok) {
          errors.push(`${url} → HTTP ${resp.status}`)
          break // 该地址被拒，换下一个候选，不必重试
        }
        const { bytes, interrupted, total } = await readBodyChunked(resp)
        const isPdf = bytes.subarray(0, 5).toString('latin1').startsWith('%PDF')
        if (!isPdf) {
          errors.push(`${url} → 非 PDF（前 40 字节 ${JSON.stringify(bytes.subarray(0, 40).toString('latin1'))}）`)
          break
        }
        if (interrupted !== undefined) {
          errors.push(`${url} → 中断（已收 ${total} 字节：${interrupted}）`)
          continue // 重试同一地址
        }
        return { bytes, url }
      } catch (error) {
        errors.push(`${url} → ${error.name}: ${error.message}`)
      }
      await sleep(2000 * attempt)
    }
  }
  throw new Error(errors.join(' | '))
}

// ── 名单 ──────────────────────────────────────────────────────────────────
const rows = onlyIds.length > 0
  ? database.raw.prepare(`SELECT paper_id, title, arxiv_id FROM papers WHERE paper_id IN (${onlyIds.map(() => '?').join(',')})`).all(...onlyIds)
  : database.raw.prepare(`
      SELECT paper_id, title, arxiv_id FROM papers
      WHERE pdf_status = 'pending' AND arxiv_id IS NOT NULL AND arxiv_id != ''
      ORDER BY year DESC, paper_id ASC
    `).all()

const queue = limitN > 0 ? rows.slice(0, limitN) : rows
console.log(`候选 ${queue.length} 篇（有 arXiv ID 且待下载）`)

if (dryRun) {
  for (const row of queue) console.log(`  [${row.arxiv_id}] ${row.paper_id}  ${String(row.title).slice(0, 60)}`)
  database.close()
  console.log('DRY RUN（未下载）')
  process.exit(0)
}

// ── 下载 ──────────────────────────────────────────────────────────────────
let ok = 0
let skipped = 0
let failed = 0
const now = () => new Date().toISOString()

for (const [index, row] of queue.entries()) {
  const arxivId = String(row.arxiv_id).trim()
  const target = resolve(PDF_DIR, `${slug(arxivId)}.pdf`)
  const label = `[${index + 1}/${queue.length}] ${row.paper_id}`

  if (await existingPdf(target)) {
    database.raw.prepare("UPDATE papers SET pdf_path = ?, pdf_status = 'downloaded', updated_at = ? WHERE paper_id = ?")
      .run(target, now(), row.paper_id)
    skipped += 1
    console.log(`${label} ↷ 本地已有 PDF，仅补登记`)
    continue
  }

  try {
    const { bytes, url } = await fetchArxivPdf(arxivId)
    await writeFile(target, bytes)
    database.raw.prepare("UPDATE papers SET pdf_path = ?, pdf_status = 'downloaded', updated_at = ? WHERE paper_id = ?")
      .run(target, now(), row.paper_id)
    ok += 1
    console.log(`${label} ✓ ${Math.round(bytes.length / 1024)}KB  via ${url}`)
  } catch (error) {
    failed += 1
    console.error(`${label} ✗ ${String(error.message).slice(0, 200)}`)
  }
  await sleep(SLEEP_MS)
}

database.close()
console.log(`\nARXIV FETCH —— 成功 ${ok}，补登记 ${skipped}，失败 ${failed}`)
