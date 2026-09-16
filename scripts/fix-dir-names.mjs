/**
 * 修复历史目录名：截断后落在空格上产生的「尾随空格目录名」。
 *
 * 背景（E24 续）：`safeDirName` 早期版本只截断不去尾随空格，3 篇 `local:` 论文的
 * 目录名以空格结尾。Node 的 statSync 能读（所以 md_path 完整性检查全绿），
 * 但 PowerShell / 资源管理器 / 多数 Windows API 读不到——典型的「检查绿、别处打不开」。
 *
 * 用法：node scripts/fix-dir-names.mjs [--dry-run]
 */

import { renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { safeDirName, legacyDirName } from './lib/safe-dir-name.mjs'

const dryRun = process.argv.includes('--dry-run')
const db = new PaperDatabase('data/papers/metadata.db')
const rows = db.raw
  .prepare("SELECT paper_id, md_path FROM papers WHERE md_path IS NOT NULL AND md_path != ''")
  .all()

let fixed = 0
let skipped = 0
for (const row of rows) {
  const fixedDir = safeDirName(row.paper_id)
  const legacyDir = legacyDirName(row.paper_id)
  if (fixedDir === legacyDir) continue

  const oldPath = resolve('data/papers/markdown', legacyDir)
  const newPath = resolve('data/papers/markdown', fixedDir)
  if (!existsSync(oldPath)) {
    skipped += 1
    console.log(`↷ 旧目录不存在（已修过或另有布局）：${row.paper_id.slice(0, 50)}`)
    continue
  }
  if (existsSync(newPath)) {
    skipped += 1
    console.log(`⚠ 目标目录已存在，跳过：${fixedDir}`)
    continue
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}重命名：\n  旧 ${legacyDir}\n  新 ${fixedDir}`)
  if (!dryRun) {
    renameSync(oldPath, newPath)
    db.raw
      .prepare('UPDATE papers SET md_path = ?, updated_at = ? WHERE paper_id = ?')
      .run(`markdown/${fixedDir}/full.md`, new Date().toISOString(), row.paper_id)
  }
  fixed += 1
}

console.log(`\n${dryRun ? 'DRY RUN' : 'FIX OK'} —— 修复 ${fixed}，跳过 ${skipped}`)
db.close()
