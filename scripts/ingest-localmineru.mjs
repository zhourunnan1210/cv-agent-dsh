/**
 * 把本地 MinerU 的产出整合进仓库既有约定，并回写数据库。
 *
 * 背景：本地 MinerU 的产出布局是 `<out>/<扁平slug>/auto/<slug>.md` + `auto/images/`，
 * 而仓库既有约定是 `data/papers/markdown/<DOI段>/full.md` + 同级 `images/`
 * （下游的结构化提取按这个约定找图）。
 *
 * 用法：node scripts/ingest-localmineru.mjs [--dry-run]
 */
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { safeDirName } from './lib/safe-dir-name.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const LOCAL_ROOT = resolve('data/papers/markdown-local')
const TARGET_ROOT = resolve('data/papers/markdown')
const MANIFEST = join(LOCAL_ROOT, 'manifest.jsonl')

const database = new PaperDatabase('data/papers/metadata.db')

const rows = (await readFile(MANIFEST, 'utf8'))
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))

console.log(`manifest ${rows.length} 条，dry-run=${dryRun}\n`)

let done = 0
let skipped = 0
const problems = []

for (const row of rows) {
  const stem = row.stem
  const paperId = stem.replace(/_/g, '/')
  const record = database.raw.prepare('SELECT paper_id, md_path FROM papers WHERE paper_id = ?').get(paperId)

  if (record === undefined) {
    problems.push({ stem, why: `库里找不到 paper_id=${paperId}` })
    continue
  }
  if (row.status !== 'ok' || row.md_files.length === 0) {
    problems.push({ stem, why: `manifest 状态 ${row.status}` })
    continue
  }

  const sourceMd = row.md_files[0]
  const sourceAuto = dirname(sourceMd)
  const targetDir = resolve(TARGET_ROOT, safeDirName(paperId))
  const targetMd = join(targetDir, 'full.md')

  // 幂等：目标已存在同尺寸产物就跳过
  const existing = await stat(targetMd).catch(() => undefined)
  const sourceInfo = await stat(sourceMd)
  if (existing !== undefined && existing.size === sourceInfo.size) {
    skipped += 1
    continue
  }

  if (dryRun) {
    console.log(`  [dry] ${paperId}\n        ${targetMd}`)
    continue
  }

  await mkdir(targetDir, { recursive: true })
  await cp(sourceMd, targetMd)

  // 图片：约定为 full.md 同级 images/
  const imagesSrc = join(sourceAuto, 'images')
  const imagesInfo = await stat(imagesSrc).catch(() => undefined)
  if (imagesInfo?.isDirectory()) {
    await cp(imagesSrc, join(targetDir, 'images'), { recursive: true })
  }

  const relPath = `markdown/${safeDirName(paperId)}/full.md`
  database.raw
    .prepare("UPDATE papers SET md_path = ?, parse_channel = 'mineru-local', updated_at = ? WHERE paper_id = ?")
    .run(relPath, new Date().toISOString(), paperId)
  done += 1
  console.log(`  ✓ ${paperId}\n      → ${relPath}`)
}

const report = {
  finished_at: new Date().toISOString(),
  manifest_rows: rows.length,
  ingested: done,
  skipped_existing: skipped,
  problems,
}
await writeFile('data/papers/localmineru-ingest-report.json', `${JSON.stringify(report, null, 2)}\n`)

console.log(`\n===== 整合结束 =====`)
console.log(`新入库 ${done}，已存在跳过 ${skipped}，问题 ${problems.length}`)
for (const p of problems) console.log(`  ⚠ ${p.stem}  ← ${p.why}`)
const parsed = database.raw.prepare("SELECT COUNT(*) c FROM papers WHERE md_path IS NOT NULL AND md_path != ''").get().c
const parsedLocal = database.raw.prepare("SELECT COUNT(*) c FROM papers WHERE parse_channel = 'mineru-local'").get().c
const eligible = database.raw.prepare("SELECT COUNT(*) c FROM papers WHERE (parse_channel IS NULL OR parse_channel = '') AND pdf_path IS NOT NULL AND pdf_path != ''").get().c
console.log(`\n全库已解析 ${parsed}（其中本地 MinerU ${parsedLocal}）`)
console.log(`仍待解析 ${eligible}`)
database.close()
