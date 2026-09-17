/**
 * Domain Pack 冻结（CLI，**人工评审门**）。
 *
 * 用法：
 *   node scripts/freeze-pack.mjs --dry-run                       # 只校验（评审前先看能不能过）
 *   node scripts/freeze-pack.mjs --reviewer "<你的标识>"          # 落冻结产物 + 登记注册表
 *   node scripts/freeze-pack.mjs --reviewer "..." --bind          # 同时把项目绑到该版本
 *   node scripts/freeze-pack.mjs --reviewer "..." --version 0.2   # 冻结指定版本
 *
 * 治理规则（v1.2 §3.4.4，不可跳过）：
 *   - 冻结必须带**评审人签名**：`freezeDomainPack` 在签名为空时直接抛错
 *     （「空签名等同于跳过评审」）；
 *   - 冻结后产生版本号，项目绑定到该版本；**改 pack 必须升版本，旧项目仍绑旧版本**；
 *   - 因此已存在的版本文件**拒绝覆盖**。
 *
 * ⚠️ 与 `scripts/bootstrap-pack.mjs` 同样的纪律：**校验与冻结逻辑只有一份**，
 * 在 `packages/dsh-plugin/src/domain/pack-builder.ts`，会话内的
 * `cvagent_domain_freeze` 工具用的是同一份。脚本自己实现一遍校验，迟早会出现
 * 「脚本说能冻、工具说不能」。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { freezeDraft, validatePackDraft } from '../packages/dsh-plugin/lib/domain/pack-builder.js'

const args = process.argv.slice(2)
const optValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const bind = args.includes('--bind')
const reviewer = optValue('--reviewer')
const packId = optValue('--pack-id') ?? 'deepfake-detection'
const version = optValue('--version') ?? '0.1'
const projectId = optValue('--project') ?? 'cv-research-project'

const draftPath = optValue('--draft') ?? resolve('data/packs', `${packId}-${version}.draft.json`)
const frozenPath = resolve('data/packs', `${packId}-${version}.json`)

if (!existsSync(draftPath)) {
  console.error(`✗ 找不到草案：${draftPath}`)
  console.error('  先生成草案：node scripts/bootstrap-pack.mjs（或会话内 cvagent_domain_bootstrap）')
  process.exit(2)
}
const draft = JSON.parse(await readFile(draftPath, 'utf8'))

const validation = validatePackDraft(draft)
const draftVersion = draft.ref?.version ?? '(缺)'
console.log(`草案：${draftPath}`)
console.log(`  pack：${draft.ref?.pack_id}@${draftVersion}`)
console.log(`  校验：${validation.problems.length === 0 ? '通过' : `未通过 ${validation.problems.length} 条`}`)
for (const problem of validation.problems) console.error(`  ✗ ${problem}`)
for (const note of validation.notes) console.warn(`  ⚠ ${note}`)

if (validation.problems.length > 0) {
  console.error('\n✗ 契约校验未通过，拒绝冻结。')
  process.exit(1)
}

if (dryRun) {
  console.log(`\nDRY RUN —— 未冻结。将通过时要写入 ${frozenPath}${bind ? `，并把 (${projectId}) 绑定到该版本` : ''}。`)
  process.exit(0)
}

if (reviewer === undefined || reviewer.trim() === '') {
  console.error('\n✗ 冻结必须带评审人签名：--reviewer "<你的标识>"。')
  console.error('  （空签名等同于跳过人工评审；v1.2 §3.4.4 规定该步在任何模式下都不可豁免）')
  process.exit(2)
}

if (existsSync(frozenPath)) {
  console.error(`\n✗ 版本 ${version} 已冻结（${frozenPath} 已存在）。`)
  console.error('  修改已冻结的 pack 必须升版本（例如 0.2），旧项目仍绑旧版本。')
  console.error('  会话内推荐做法：cvagent_domain_propose_revision（自动升版本 + 差异摘要）。')
  process.exit(2)
}

if (draftVersion !== version) {
  console.error(`\n✗ 草案里的版本（${draftVersion}）与要冻结的版本（${version}）不一致。`)
  console.error('  这通常意味着草案是用别的版本参数生成的——版本号必须一致，否则注册表会指错文件。')
  process.exit(2)
}

const { frozen, contentHash } = freezeDraft(draft, reviewer, new Date().toISOString())
await mkdir(resolve('data/packs'), { recursive: true })
await writeFile(frozenPath, `${JSON.stringify(frozen, null, 2)}\n`)

const database = new PaperDatabase('data/papers/metadata.db')
database.raw
  .prepare('INSERT OR REPLACE INTO domain_packs (pack_id, version, frozen_by, frozen_at, pack_path) VALUES (?, ?, ?, ?, ?)')
  .run(frozen.ref.pack_id, frozen.ref.version, frozen.frozen_by, frozen.frozen_at, frozenPath)
if (bind) {
  database.raw
    .prepare('INSERT OR REPLACE INTO project_pack_binding (project_id, pack_id, version) VALUES (?, ?, ?)')
    .run(projectId, frozen.ref.pack_id, frozen.ref.version)
}
const registered = database.raw.prepare('SELECT pack_id, version, frozen_by FROM domain_packs ORDER BY pack_id, version').all()
const bindings = database.raw.prepare('SELECT project_id, pack_id, version FROM project_pack_binding').all()
database.close()

console.log(`\n✓ 已冻结：${frozenPath}`)
console.log(`  frozen_by=${frozen.frozen_by}  frozen_at=${frozen.frozen_at}`)
console.log(`  内容哈希=${contentHash}（审计时用于比对内容是否被改动）`)
console.log(`  注册表 domain_packs：${JSON.stringify(registered)}`)
console.log(`  绑定 project_pack_binding：${JSON.stringify(bindings)}${bind ? '' : '（未 --bind）'}`)
