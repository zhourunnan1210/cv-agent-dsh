/**
 * P2-7 · 批量 MinerU 解析：把「未解析且有本地 PDF」的论文分块提交、轮询、
 * 解压落盘、落库 md_path 并做额度记账（2000 页/天账本监督）。
 *
 * 用法：
 *   node scripts/batch-parse.mjs [--limit N] [--chunk C] [--dry-run] [--resume]
 *
 * - 默认处理全部合格论文（pdf_path 非空且 parse_channel 为空），按
 *   「有外部 ID 优先、年份新者优先」排序；
 * - 每次提交一个 chunk（默认 20 个文件）的 file-urls/batch；**全部 chunk
 *   先提交**（MinerU 并发处理），再逐块轮询、下载解压、落库记账；
 *   提交过的 chunk 写 data/papers/batch-state.json，进程中断后
 *   `--resume` 只轮询+落库并退出，**不重复提交、不重复计费**（剩余论文
 *   再跑一次本脚本提交）；
 * - 额度门：提交前用本地 pdf-parse 页数做预算，剩余额度放不下时截断
 *   （告警阈值 80% 由账本自身给出）；
 * - `--dry-run` 只做预算与名单打印，不提交。
 *
 * 前置：MINERU_TOKEN（.env.local 或环境）。mineru.net 国内直连，不走代理。
 */

import { basename, resolve } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { MineruClient } from '../packages/dsh-plugin/lib/kb/mineru.js'
import { MineruQuotaLedger } from '../packages/dsh-plugin/lib/kb/mineru-quota.js'
import { safeDirName as sharedSafeDirName } from './lib/safe-dir-name.mjs'

// ── 参数 ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
const flag = (name) => args.includes(name)
const limitN = Number(opt('--limit') ?? 0)
const chunkSize = Number(opt('--chunk') ?? 20)
const dryRun = flag('--dry-run')
const resume = flag('--resume')
/** 定向补收一个已提交的 batch（哪怕 state 里已标 done）：代理/网络故障后的补救入口。 */
const resumeBatch = opt('--resume-batch')

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
const quota = new MineruQuotaLedger(resolve('data/mineru-quota.json'))
await quota.load()

const STATE_PATH = 'data/papers/batch-state.json'

/** 上传名 → paper_id 的唯一映射：上传名用 sanitized(paper_id).pdf，避免重名。 */
const sanitizeName = (id) => id.replace(/[^A-Za-z0-9_.-]/g, '_')

/**
 * markdown 落盘目录名：把 paper_id 变成文件系统安全的名字。
 * 实现与修复脚本共用 `scripts/lib/safe-dir-name.mjs`（规则见该文件）。
 */
const safeDirName = sharedSafeDirName

// ── 名单：未解析且有本地 PDF ──────────────────────────────────────────────
const rows = database.raw
  .prepare(`
    SELECT paper_id, title, pdf_path, year FROM papers
    WHERE pdf_path IS NOT NULL AND pdf_path != ''
      AND (parse_channel IS NULL OR parse_channel = '')
    ORDER BY (doi IS NOT NULL OR arxiv_id IS NOT NULL OR pmid IS NOT NULL) DESC, year DESC, paper_id ASC
  `)
  .all()
if (limitN > 0) rows.length = Math.min(rows.length, limitN)

// ── 本地页数预算（pdf-parse，走 vendored 包依赖，不新增依赖）──────────────
const requireVendor = createRequire('D:/Code/VScodeRepo/dsh-plugin/packages/vendor/dsh-ai4scholar/package.json')
const pdfParseEntry = requireVendor.resolve('pdf-parse')
const { PDFParse } = await import(pathToFileURL(pdfParseEntry).href)

async function localPages(pdfPath) {
  try {
    const bytes = await readFile(pdfPath)
    const pdf = new PDFParse({ data: bytes })
    try {
      const result = await pdf.getText()
      return Number(result.total) || 1
    } finally {
      await pdf.destroy()
    }
  } catch (error) {
    console.warn(`  ⚠ 本地页数读取失败（${pdfPath}）：${error.message}；按 1 页计`)
    return 1
  }
}

// ── 状态文件：已提交未完成的 chunk（进程中断后 --resume 续跑）─────────────
let state = { chunks: [] }
try {
  state = JSON.parse(await readFile(STATE_PATH, 'utf8'))
} catch {
  // 无状态文件
}
const pending = state.chunks.filter((chunk) => chunk.status === 'submitted')

const client = new MineruClient({
  baseUrl: 'https://mineru.net/api/v4',
  resolveToken: async () => process.env.MINERU_TOKEN,
  pollIntervalMs: 8000,
  pollTimeoutMs: 30 * 60 * 1000,
})

async function saveState() {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2))
}

/** 提交块的重试包装：429 退避重试（file-urls/batch 实测有比文档更紧的频控）。 */
async function submitWithRetry(files, attempts = 5) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.submitLocalFiles(files)
    } catch (error) {
      if (error?.code !== 429 && error?.code !== 403) throw error
      lastError = error
      const waitMs = Math.min(5000 * 2 ** (attempt - 1), 80000)
      console.warn(`  ⚠ 提交被限流（${error.code}），${Math.round(waitMs / 1000)}s 后第 ${attempt + 1}/${attempts} 次重试…`)
      await sleep(waitMs)
    }
  }
  throw lastError
}

/** 轮询一个 chunk 并逐篇落库、记账；返回 {ok, failed} 计数。 */
async function finalizeChunk(chunk) {
  console.log(`轮询 batch ${chunk.batchId}（${chunk.items.length} 个文件）…`)
  const result = await client.pollBatch(chunk.batchId)
  let ok = 0
  let failed = 0
  const now = new Date().toISOString()
  const byName = new Map(chunk.items.map((item) => [item.name, item]))
  const byDataId = new Map(chunk.items.map((item) => [item.paperId, item]))
  for (const file of result.files) {
    // 对账优先用 data_id（实测原样回传，不受文件名 sanitize/截断影响），再退到文件名
    const item = (file.dataId === undefined ? undefined : byDataId.get(file.dataId)) ?? byName.get(file.fileName)
    const paperId = item?.paperId
    if (item === undefined) {
      console.warn(`  ⚠ 未知文件：${file.fileName}`)
      continue
    }
    try {
      // 幂等：已解析过的（即使 state 里还是 submitted，例如中断后重跑）直接跳过，
      // 不重复下载、不重复记账（L1：本地 PDF 论文重跑时被重复计过页数）
      const current = database.raw
        .prepare('SELECT parse_channel, md_path FROM papers WHERE paper_id = ?')
        .get(paperId)
      if (current?.parse_channel === 'mineru' && current?.md_path) {
        console.log(`  ↷ ${paperId}（已解析，跳过）`)
        ok += 1
        continue
      }
      if (file.state !== 'done' || file.fullZipUrl === undefined) {
        failed += 1
        console.warn(`  ✗ ${paperId}（${file.state}${file.errMsg ? `：${file.errMsg}` : ''}）`)
        database.raw
          .prepare("UPDATE papers SET parse_channel = 'failed', updated_at = ? WHERE paper_id = ?")
          .run(now, paperId)
        continue
      }
      const dirName = safeDirName(paperId)
      const markdownDir = resolve('data/papers/markdown', dirName)
      const written = await client.downloadExtract(file.fullZipUrl, markdownDir)
      const fullPath = resolve('data/papers/markdown', dirName, 'full.md')
      const hasFull = written.some((path) => resolve(path).toLowerCase() === fullPath.toLowerCase())
      if (!hasFull) {
        failed += 1
        console.warn(`  ✗ ${paperId}（解压产物缺 full.md，实得 ${written.length} 个文件）`)
        database.raw
          .prepare("UPDATE papers SET parse_channel = 'failed', updated_at = ? WHERE paper_id = ?")
          .run(now, paperId)
        continue
      }
      database.raw
        .prepare("UPDATE papers SET parse_channel = 'mineru', md_path = ?, updated_at = ? WHERE paper_id = ?")
        .run(`markdown/${dirName}/full.md`, now, paperId)
      const status = await quota.record(item.pages)
      ok += 1
      console.log(`  ✓ ${paperId}（${item.pages}p，解压 ${written.length} 个文件）→ 今日已用 ${status.usedPages}/${status.limit}${status.warning ? '（⚠ 已达告警阈值）' : ''}`)
    } catch (error) {
      // 单篇失败不能拖垮整批（L1：local: 论文 ID 里的 ':' 曾让 mkdir ENOENT 直接崩进程）
      failed += 1
      console.warn(`  ✗ ${paperId}（处理异常：${error.message}）`)
      database.raw
        .prepare("UPDATE papers SET parse_channel = 'failed', updated_at = ? WHERE paper_id = ?")
        .run(now, paperId)
    }
  }
  chunk.status = 'done'
  await saveState()
  return { ok, failed }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── 定向补收一个 batch（`--resume-batch <id>`）─────────────────────────────
// 适用场景：MinerU 侧已经 done，但我们这侧因网络/代理故障没能下载落库
// （state 里的 chunk 已被标 done，常规 --resume 不会再碰它）。
if (resumeBatch !== undefined) {
  const chunk = state.chunks.find((item) => item.batchId === resumeBatch)
  if (chunk === undefined) {
    console.error(`state 里没有 batch ${resumeBatch}（items 无法对账）。`)
    database.close()
    process.exit(2)
  }
  chunk.status = 'submitted'
  await saveState()
  const { ok, failed } = await finalizeChunk(chunk)
  database.close()
  console.log(`\nRESUME BATCH OK —— batch ${resumeBatch}：成功 ${ok}，失败 ${failed}`)
  process.exit(0)
}

// ── 遗留 chunk 的处置 ───────────────────────────────────────────────────────
let totalOk = 0
let totalFailed = 0
if (pending.length > 0 && !resume) {
  console.error(`存在 ${pending.length} 个已提交未落库的 chunk（batch_id：${pending.map((c) => c.batchId).join(', ')}）。`)
  console.error('请用 --resume 续跑（只轮询+落库，不重复提交、不重复计费）。')
  database.close()
  process.exit(2)
}
if (resume && pending.length > 0) {
  for (const chunk of pending) {
    const { ok, failed } = await finalizeChunk(chunk)
    totalOk += ok
    totalFailed += failed
  }
  console.log(`\nRESUME OK —— 成功 ${totalOk}，失败 ${totalFailed}（剩余未解析论文请再次运行本脚本提交）`)
  database.close()
  process.exit(0)
}

// ── 新提交的名单与页数预算 ─────────────────────────────────────────────────
console.log(`合格论文（未解析 + 有 PDF）：${rows.length} 篇；chunk=${chunkSize}`)
const planned = []
let budgetPages = 0
const remaining = quota.status.limit - quota.status.usedPages
for (const row of rows) {
  const pages = await localPages(row.pdf_path)
  budgetPages += pages
  if (budgetPages > remaining) {
    console.log(`⚠ 预算页数已达剩余额度（${remaining} 页，第 ${planned.length + 1} 篇起截断）：本轮只处理 ${planned.length} 篇`)
    break
  }
  planned.push({ paperId: row.paper_id, title: row.title, pdfPath: row.pdf_path, pages })
}
console.log(`计划解析 ${planned.length} 篇，预算 ${budgetPages} 页（今日已用 ${quota.status.usedPages}/${quota.status.limit}）`)
if (planned.length === 0) {
  console.log('无可处理论文（或额度已满）。')
  database.close()
  process.exit(0)
}
if (dryRun) {
  for (const item of planned) console.log(`  [${item.paperId}] ${item.pages}p  ${item.title.slice(0, 70)}`)
  database.close()
  console.log('DRY RUN OK（未提交）')
  process.exit(0)
}

// ── 阶段 A：全部 chunk 先提交（MinerU 并发处理，缩短墙钟时间）─────────────
const submitted = []
for (let start = 0; start < planned.length; start += chunkSize) {
  const slice = planned.slice(start, start + chunkSize)
  console.log(`提交第 ${start / chunkSize + 1} 块：${slice.length} 个文件`)
  const files = slice.map((item) => ({
    name: `${sanitizeName(item.paperId)}.pdf`,
    path: item.pdfPath,
    data_id: item.paperId,
  }))
  const batchId = await submitWithRetry(files)
  console.log(`batch_id: ${batchId}`)
  const chunk = {
    batchId,
    status: 'submitted',
    items: slice.map((item) => ({ name: `${sanitizeName(item.paperId)}.pdf`, paperId: item.paperId, pages: item.pages })),
  }
  state.chunks.push(chunk)
  submitted.push(chunk)
  await saveState()
  if (start + chunkSize < planned.length) {
    // 实测 file-urls/batch 有比文档更紧的频控（第 3 块即 429）：块间留间隔
    console.log('  块间停顿 6s（避免提交频控）…')
    await sleep(6000)
  }
}
console.log(`\n全部 ${submitted.length} 块已提交，开始轮询落库…`)

// ── 阶段 B：逐块轮询 + 解压落库 + 记账 ─────────────────────────────────────
for (const chunk of submitted) {
  const { ok, failed } = await finalizeChunk(chunk)
  totalOk += ok
  totalFailed += failed
}

database.close()
console.log(`\nBATCH PARSE OK —— 成功 ${totalOk}，失败 ${totalFailed}`)
