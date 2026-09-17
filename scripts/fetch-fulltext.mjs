/**
 * 全文获取桥（Phase 3 起步）：把我们库里的「缺 PDF」论文交给 **paper-fetch skill**
 * 去解析与下载，再把结果**回写 `metadata.db`**。
 *
 * 分工（2026-09-17 与用户确认）：
 *   - **解析+下载**由 `packages/dsh-plugin/skills/paper-fetch/`（插件自有 skill，
 *     v0.14.1，Python 3，stdlib）负责：Unpaywall → Semantic Scholar → arXiv →
 *     Europe PMC/PMC → bioRxiv/medRxiv（Sci-Hub 按本仓库策略默认关闭）；
 *   - **本脚本**只做三件事：① 从 DB 生成 DOI 清单；② 把 paper-fetch 的 JSON
 *     envelope 映射回 `paper_id`；③ 写 `pdf_path` / `pdf_status`。
 *
 * 为什么分三步而不是 spawn 子进程：本 harness 的沙箱禁止「用管道捕获子进程输出」
 * （Node `child_process` 默认 `stdio:'pipe'` 会 EPERM），所以子进程的 stdout/stderr
 * 一律**重定向到文件**，本脚本只读文件。三个模式：
 *
 *   node scripts/fetch-fulltext.mjs --prepare [--limit N]
 *       → 生成 data/papers/fetch-batch.txt + fetch-plan.json，并打印要跑的命令
 *   <在 pwsh 里跑 python … > data/papers/fetch-envelope.json 2> data/papers/fetch-stderr.ndjson
 *   node scripts/fetch-fulltext.mjs --ingest
 *       → 读 envelope，回写 DB（幂等：已 downloaded 的跳过）
 *   node scripts/fetch-fulltext.mjs --status
 *       → 打印 pdf_status 分布与上次报告
 */

import { readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const mode = args.includes('--prepare') ? 'prepare' : args.includes('--ingest') ? 'ingest' : args.includes('--status') ? 'status' : undefined
if (mode === undefined) {
  console.error('用法：--prepare | --ingest | --status [--limit N]')
  process.exit(2)
}

const limitIndex = args.indexOf('--limit')
const limit = limitIndex >= 0 && args[limitIndex + 1] !== undefined ? Number(args[limitIndex + 1]) : 0

const SKILL = 'packages/dsh-plugin/skills/paper-fetch/scripts/fetch.py'
const PDF_DIR = resolve('data/papers/pdf')
const BATCH_FILE = 'data/papers/fetch-batch.txt'
const PLAN_FILE = 'data/papers/fetch-plan.json'
const ENVELOPE_FILE = 'data/papers/fetch-envelope.json'
const REPORT_FILE = 'data/papers/fetch-report.json'

const database = new PaperDatabase('data/papers/metadata.db')

/** DOI 归一化（与 core 的 normalizePaperId 同源；仅用于回填匹配）。 */
const normDoi = (value) => String(value ?? '').trim().toLowerCase()
  .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').replace(/^arxiv:\s*/, '')

/** 送进 paper-fetch 的 DOI：优先真 DOI；只有 arXiv 时合成 S2 规范的 `10.48550/arXiv.<id>`。 */
function doiForFetch(row) {
  if (typeof row.doi === 'string' && row.doi.trim() !== '') return normDoi(row.doi)
  if (typeof row.arxiv_id === 'string' && row.arxiv_id.trim() !== '') return `10.48550/arxiv.${normDoi(row.arxiv_id)}`
  return undefined
}

if (mode === 'prepare') {
  const rows = database.raw
    .prepare(`
      SELECT paper_id, title, doi, arxiv_id FROM papers
      WHERE pdf_status = 'pending' AND (doi IS NOT NULL OR arxiv_id IS NOT NULL)
      ORDER BY year DESC, paper_id ASC
    `)
    .all()
  const plan = []
  for (const row of rows) {
    const doi = doiForFetch(row)
    if (doi === undefined) continue
    plan.push({ paper_id: row.paper_id, title: row.title, doi, synthesized: row.doi === null || row.doi === undefined })
  }
  const selected = limit > 0 ? plan.slice(0, limit) : plan
  await writeFile(BATCH_FILE, `${selected.map((item) => item.doi).join('\n')}\n`)
  await writeFile(PLAN_FILE, `${JSON.stringify({ generated_at: new Date().toISOString(), count: selected.length, items: selected }, null, 2)}\n`)
  console.log(`已生成待抓清单：${selected.length} 条（其中 arXiv 合成 DOI ${selected.filter((i) => i.synthesized).length} 条）`)
  console.log(`  DOI 清单：${BATCH_FILE}`)
  console.log(`  映射表 ：${PLAN_FILE}`)
  console.log('\n请执行（stdout/stderr 一律落文件，避免管道被沙箱拒绝）：')
  console.log('  ⚠ 必须带 UTF-8 环境变量：Windows 下 Python 默认按 GBK 写 stdout，')
  console.log('    作者名含非 GBK 字符（如 ł）时，整个 JSON 信封会写不出来——前面的下载全白费（E34）。')
  console.log(`  $env:PYTHONUTF8=1; $env:PYTHONIOENCODING="utf-8"; python ${SKILL} --batch ${BATCH_FILE} --out ${PDF_DIR} --format json > ${ENVELOPE_FILE} 2> data/papers/fetch-stderr.ndjson`)
  console.log(`  node scripts/fetch-fulltext.mjs --ingest`)
  console.log('')
  console.log('  arXiv HTTPS 在本机被拦（一律 406）。带 arXiv ID 的论文改用定向取用脚本（走 export.arxiv.org 的 http 通道 + 分块重试）：')
  console.log(`  $env:PYTHONUTF8=1; python scripts/fetch-arxiv-pdf.mjs --prepare   # 生成清单`)
  console.log(`  python data/papers/_arxiv-fetch3.py                              # 或直接用既有脚本抓取`)
  database.close()
  process.exit(0)
}

if (mode === 'ingest') {
  let envelope
  try {
    envelope = JSON.parse(await readFile(ENVELOPE_FILE, 'utf8'))
  } catch (error) {
    console.error(`读不到 paper-fetch 的 envelope（${ENVELOPE_FILE}）：${error.message}`)
    console.error('先按 --prepare 打印的命令跑一次 paper-fetch。')
    database.close()
    process.exit(2)
  }
  const plan = JSON.parse(await readFile(PLAN_FILE, 'utf8'))
  const byDoi = new Map(plan.items.map((item) => [normDoi(item.doi), item]))
  const results = Array.isArray(envelope?.data?.results) ? envelope.data.results : []
  console.log(`envelope：ok=${envelope?.ok}，results ${results.length} 条（plan ${plan.count} 条）`)

  const report = {
    ingested_at: new Date().toISOString(),
    envelopeOk: envelope?.ok,
    sourcesTried: envelope?.meta?.sources_tried ?? [],
    authMode: envelope?.meta?.auth_mode,
    total: results.length,
    saved: 0,
    alreadyDownloaded: 0,
    notFound: 0,
    failures: [],
    unmapped: [],
  }
  const now = new Date().toISOString()
  for (const result of results) {
    const item = byDoi.get(normDoi(result?.doi))
    if (item === undefined) {
      report.unmapped.push({ doi: result?.doi, file: result?.file })
      continue
    }
    if (result?.success !== true || typeof result.file !== 'string') {
      report.notFound += 1
      report.failures.push({ paper_id: item.paper_id, doi: result?.doi, code: result?.error?.code ?? null, message: result?.error?.message ?? result?.skip_reason ?? 'unknown' })
      continue
    }
    const absolute = resolve(result.file)
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined) {
      report.failures.push({ paper_id: item.paper_id, doi: result.doi, code: 'file_missing', message: absolute })
      continue
    }
    // 二次校验：即便 paper-fetch 已校验过，落库前仍确认是 PDF（防止 HTML 混入）
    const head = await readFile(absolute).then((buffer) => buffer.subarray(0, 5).toString('latin1'))
    if (!head.startsWith('%PDF')) {
      report.failures.push({ paper_id: item.paper_id, doi: result.doi, code: 'not_pdf_on_disk', message: `${absolute}（魔数 ${JSON.stringify(head)}）` })
      continue
    }
    const current = database.raw.prepare('SELECT pdf_status FROM papers WHERE paper_id = ?').get(item.paper_id)
    database.raw
      .prepare("UPDATE papers SET pdf_path = ?, pdf_status = 'downloaded', updated_at = ? WHERE paper_id = ?")
      .run(absolute, now, item.paper_id)
    if (current?.pdf_status === 'downloaded') report.alreadyDownloaded += 1
    else report.saved += 1
    console.log(`✓ ${item.paper_id}（${Math.round(info.size / 1024)}KB，source=${result.source ?? '-'}${result.via ? `，via=${result.via}` : ''}）`)
  }
  report.pdfStatusCounts = database.raw.prepare('SELECT pdf_status, COUNT(*) c FROM papers GROUP BY pdf_status').all()
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`)
  database.close()
  console.log('\n── 全文获取回填报告 ───────────────────────────')
  console.log(`envelope ${report.total} 条：入库 ${report.saved}、已存在 ${report.alreadyDownloaded}、无 OA ${report.notFound}、失败 ${report.failures.length}、无法映射 ${report.unmapped.length}`)
  console.log(`pdf_status：${JSON.stringify(report.pdfStatusCounts)}`)
  for (const item of report.failures.slice(0, 15)) console.log(`  ✗ ${item.paper_id}：${item.code} ${String(item.message).slice(0, 90)}`)
  process.exit(0)
}

// ── --status ──────────────────────────────────────────────────────────────
const counts = database.raw.prepare('SELECT pdf_status, COUNT(*) c FROM papers GROUP BY pdf_status').all()
const eligible = database.raw
  .prepare("SELECT COUNT(*) c FROM papers WHERE pdf_path IS NOT NULL AND pdf_path != '' AND (parse_channel IS NULL OR parse_channel = '')")
  .get().c
console.log(`pdf_status：${JSON.stringify(counts)}`)
console.log(`可解析（有 pdf_path 且未解析）：${eligible}`)
const report = await readFile(REPORT_FILE, 'utf8').then(JSON.parse).catch(() => undefined)
if (report !== undefined) {
  // 兼容旧版报告形状（早期直连下载脚本写的是 failed / downloaded 字段）
  const failures = report.failures?.length ?? report.failed?.length ?? 0
  const saved = report.saved ?? report.downloaded ?? 0
  console.log(`上次回填（${report.ingested_at ?? report.finished_at ?? '未知时间'}）：入库 ${saved}、已存在 ${report.alreadyDownloaded ?? report.skippedExisting ?? 0}、无 OA ${report.notFound ?? 0}、失败 ${failures}`)
}
database.close()
