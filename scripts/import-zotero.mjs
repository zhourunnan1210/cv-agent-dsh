/**
 * P2-5 · Zotero 本地论文库导入。
 *
 * 流程（不消耗任何网络额度）：
 *   1. 快照 Zotero 的 zotero.sqlite（Zotero 运行时原库被锁，复制到 .tmp-zotero/）；
 *   2. 只读解析快照：attachments → 父条目元数据（title/DOI/arXiv/日期/venue/作者）；
 *   3. 逐篇构建 PaperRecord（paper_id=DOI → arXiv → local:<attachmentKey>，
 *      source_channel='manual'，pdf_status='downloaded'，pdf_path=绝对路径）；
 *   4. 经 PaperLibrary 落库 data/papers/metadata.db（去重/合并按 §7.5.2）。
 *
 * 用法：node scripts/import-zotero.mjs
 * 幂等：重复运行会按 paper_id/DOI 合并，不产生新行。
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import { normalizePaperId } from '../packages/core/lib/index.js'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'

/**
 * Zotero 数据目录。**不要写死开发机路径**——用环境变量或默认位置。
 *
 * 默认位置按平台惯例：Windows `~/Zotero`（Zotero 的默认安装位置）、
 * macOS/Linux `~/Zotero`。装在别处就设 `ZOTERO_DIR`。
 */
const ZOTERO_DIR = process.env.ZOTERO_DIR ?? join(homedir(), 'Zotero')
const ZOTERO_DB = join(ZOTERO_DIR, 'zotero.sqlite')
const SNAPSHOT_DIR = resolve('.tmp-zotero')
const METADATA_DB = resolve('data/papers/metadata.db')

// ── 1. 快照（原库被运行中的 Zotero 锁住）──────────────────────────────────
await mkdir(SNAPSHOT_DIR, { recursive: true })
await copyFile(ZOTERO_DB, join(SNAPSHOT_DIR, 'zotero.sqlite'))
for (const suffix of ['-wal', '-shm']) {
  const source = `${ZOTERO_DB}${suffix}`
  if (existsSync(source)) await copyFile(source, join(SNAPSHOT_DIR, `zotero.sqlite${suffix}`))
}

// ── 2. 只读解析快照 ────────────────────────────────────────────────────────
const zotero = new DatabaseSync(join(SNAPSHOT_DIR, 'zotero.sqlite'), { readOnly: true })

const fieldIds = Object.fromEntries(
  zotero
    .prepare("SELECT fieldID, fieldName FROM fields WHERE fieldName IN ('title','DOI','archiveID','date','publicationTitle','conferenceName','url','abstractNote')")
    .all()
    .map((row) => [row.fieldName, row.fieldID]),
)

const attachments = zotero
  .prepare(`
    SELECT a.itemID, a.parentItemID, a.path
    FROM itemAttachments a
    LEFT JOIN deletedItems d ON d.itemID = a.itemID
    WHERE a.contentType = 'application/pdf'
      AND a.path LIKE 'storage:%'
      AND a.parentItemID IS NOT NULL
      AND d.itemID IS NULL
  `)
  .all()

const getField = zotero.prepare(`
  SELECT v.value
  FROM itemData d
  JOIN itemDataValues v ON v.valueID = d.valueID
  WHERE d.itemID = ? AND d.fieldID = ?
`)
const getCreators = zotero.prepare(`
  SELECT c.firstName, c.lastName
  FROM itemCreators ic
  JOIN creators c ON c.creatorID = ic.creatorID
  WHERE ic.itemID = ? AND ic.creatorTypeID = 1
  ORDER BY ic.orderIndex
`)
const isDeleted = zotero.prepare('SELECT 1 FROM deletedItems WHERE itemID = ?')

function fieldValue(itemId, fieldName) {
  const id = fieldIds[fieldName]
  if (id === undefined) return undefined
  const row = getField.get(itemId, id)
  const value = row?.value
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

// ── 3. 构建记录并落库 ──────────────────────────────────────────────────────
await mkdir(resolve('data/papers'), { recursive: true })
const database = new PaperDatabase(METADATA_DB)
const library = new PaperLibrary(database)

const stats = { total: 0, byIdSource: { doi: 0, arxiv: 0, local: 0 }, inserted: 0, merged: 0, needsReview: 0, attachedLocal: 0, skippedDeleted: 0, pathFixed: 0, pathMissing: 0 }
const needsReview = []
const now = new Date().toISOString()

/**
 * 磁盘实测校正（L1 教训）：部分 Zotero 附件的 `path` 是纯文件名
 * （'storage:<file>.pdf'），真实文件却在 key 子目录（storage/<KEY>/<file>.pdf）里。
 * 按 basename 建全量索引，直接拼接不存在时回退查找；索引一次建好复用。
 */
const pdfIndex = new Map()
async function buildPdfIndex() {
  const walk = async (dir) => {
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.toLowerCase().endsWith('.pdf')) pdfIndex.set(entry.name.toLowerCase(), full)
    }
  }
  await walk(join(ZOTERO_DIR, 'storage'))
}
function resolvePdfPath(directPath) {
  if (existsSync(directPath)) return { path: directPath, fixed: false, missing: false }
  const byName = pdfIndex.get(basename(directPath).toLowerCase())
  if (byName !== undefined) return { path: byName, fixed: true, missing: false }
  return { path: directPath, fixed: false, missing: true }
}

await buildPdfIndex()

for (const attachment of attachments) {
  stats.total += 1
  if (isDeleted.get(attachment.parentItemID) !== undefined) {
    stats.skippedDeleted += 1
    continue
  }
  const title = fieldValue(attachment.parentItemID, 'title')
  const doi = fieldValue(attachment.parentItemID, 'DOI')
  const arxiv = fieldValue(attachment.parentItemID, 'archiveID')
  const date = fieldValue(attachment.parentItemID, 'date')
  const venue = fieldValue(attachment.parentItemID, 'publicationTitle') ?? fieldValue(attachment.parentItemID, 'conferenceName')
  const url = fieldValue(attachment.parentItemID, 'url')
  const abstract = fieldValue(attachment.parentItemID, 'abstractNote')

  const authors = getCreators
    .all(attachment.parentItemID)
    .map((creator) => `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim())
    .filter((name) => name !== '')

  const attachmentKey = String(attachment.path).replace(/^storage:/, '')
  const resolvedPdf = resolvePdfPath(join(ZOTERO_DIR, 'storage', attachmentKey))
  if (resolvedPdf.missing) {
    stats.pathMissing += 1
    console.log(`⚠ pdf 文件在磁盘上找不到（跳过）：${attachmentKey}`)
    continue
  }
  if (resolvedPdf.fixed) stats.pathFixed += 1
  const pdfPath = resolvedPdf.path

  let paperId
  let idSource
  if (doi !== undefined) {
    paperId = normalizePaperId(doi)
    idSource = 'doi'
  } else if (arxiv !== undefined) {
    paperId = normalizePaperId(arxiv)
    idSource = 'arxiv'
  } else {
    paperId = `local:${attachmentKey}`
    idSource = 'local'
  }
  stats.byIdSource[idSource] += 1

  const record = {
    paper_id: paperId,
    title: title ?? attachmentKey,
    authors,
    ...(doi === undefined ? {} : { doi: normalizePaperId(doi) }),
    ...(arxiv === undefined ? {} : { arxiv_id: normalizePaperId(arxiv) }),
    ...(date === undefined ? {} : { year: Number(/^\d{4}/.exec(date)?.[0]) }),
    ...(venue === undefined ? {} : { venue }),
    ...(url === undefined ? {} : { url }),
    ...(abstract === undefined ? {} : { abstract }),
    source_channel: 'manual',
    pdf_status: 'downloaded',
    pdf_path: pdfPath,
    created_at: now,
    updated_at: now,
  }

  const outcome = library.upsert(record)
  if (outcome.inserted) stats.inserted += 1
  if (outcome.merged) stats.merged += 1
  if (outcome.needs_review) {
    // 导入期专项：标题命中且一侧是 local、另一侧有外部 ID → 同一篇论文，
    // 把本地 PDF 路径挂到带外部 ID 的记录上（不是标题合并，是补文件位置）。
    const existing = outcome.merged_into === null ? undefined : library.get(outcome.merged_into)
    if (existing !== undefined && paperId.startsWith('local:') && (existing.doi !== undefined || existing.arxiv_id !== undefined)) {
      library.upsert({ ...existing, pdf_path: pdfPath, updated_at: now })
      stats.attachedLocal += 1
    } else {
      stats.needsReview += 1
      needsReview.push(`${paperId} (库内 ${outcome.merged_into}) ← ${record.title}`)
    }
  }
}

// ── 4. 报告 ─────────────────────────────────────────────────────────────────
console.log('── Zotero 导入完成 ──────────────────────────────')
console.log(`附件总数（pdf/storage）: ${stats.total}`)
console.log(`跳过（父条目已删除）    : ${stats.skippedDeleted}`)
console.log(`ID 来源  : doi=${stats.byIdSource.doi}, arxiv=${stats.byIdSource.arxiv}, local=${stats.byIdSource.local}`)
console.log(`写入结果 : inserted=${stats.inserted}, merged=${stats.merged}, needs_review=${stats.needsReview}, 本地文件挂接=${stats.attachedLocal}`)
console.log(`路径校正 : 磁盘实测命中 ${stats.pathFixed} 条，缺失 ${stats.pathMissing} 条`)
console.log(`库内总数 : ${library.count()}`)
console.log(`按通道    : ${JSON.stringify(library.countByChannel())}`)
if (needsReview.length > 0) {
  console.log('── 标题级命中（人工复核）────────────────────────')
  for (const line of needsReview.slice(0, 20)) console.log(`  ${line}`)
  if (needsReview.length > 20) console.log(`  …共 ${needsReview.length} 条`)
}

database.close()
zotero.close()
await rm(SNAPSHOT_DIR, { recursive: true, force: true })
void readdir
