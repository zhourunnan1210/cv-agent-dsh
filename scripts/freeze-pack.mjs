/**
 * P3-2 · Domain Pack 冻结（**人工评审门**，v1.2 §3.4.4 / `core/src/domain/pack.ts`）。
 *
 * 治理规则（不可跳过，类型级强制）：
 *   - 冻结必须带**评审人签名**；`freezeDomainPack()` 在签名为空时直接抛错——
 *     「空签名等同于跳过评审」；
 *   - 冻结后生成版本号，项目绑定到具体版本；**改 pack 产生新版本，旧项目仍绑旧版本**；
 *   - 因此已存在的版本文件**拒绝覆盖**（要改就 bump 版本）。
 *
 * 用法：
 *   node scripts/freeze-pack.mjs --dry-run                     # 只校验，不冻结
 *   node scripts/freeze-pack.mjs --reviewer "周润楠"            # 落冻结产物 + 记库
 *   node scripts/freeze-pack.mjs --reviewer "..." --bind        # 同时把当前项目绑到该版本
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve } from 'node:path'

import { freezeDomainPack } from '../packages/core/lib/index.js'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const args = process.argv.slice(2)
const optValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const bind = args.includes('--bind')
const reviewer = optValue('--reviewer')
const draftPath = optValue('--draft') ?? 'data/packs/deepfake-detection-0.1.draft.json'
const PROJECT_ID = optValue('--project') ?? 'cv-research-default'

const draft = JSON.parse(await readFile(draftPath, 'utf8'))

// ── 契约校验（冻结前的最后一道闸）──────────────────────────────────────────
const problems = []
if (typeof draft.ref?.pack_id !== 'string' || draft.ref.pack_id === '') problems.push('ref.pack_id 缺失')
if (typeof draft.ref?.version !== 'string' || draft.ref.version === '') problems.push('ref.version 缺失')
if (!Array.isArray(draft.seed_papers) || draft.seed_papers.length === 0) problems.push('seed_papers 为空（pack 必须可溯源到种子论文）')
for (const store of ['problems', 'methods', 'innovations']) {
  const fields = draft.schema_ext?.[store]
  if (fields === undefined || typeof fields !== 'object') {
    problems.push(`schema_ext.${store} 缺失`)
    continue
  }
  for (const [field, spec] of Object.entries(fields)) {
    if (!['text', 'enum', 'number', 'boolean'].includes(spec?.type)) problems.push(`schema_ext.${store}.${field}.type 非法：${spec?.type}`)
    if (spec?.type === 'enum' && (!Array.isArray(spec.values) || spec.values.length === 0)) {
      problems.push(`schema_ext.${store}.${field} 是 enum 但没有 values`)
    }
  }
}
if (!Array.isArray(draft.lexicon?.terms) || draft.lexicon.terms.length === 0) problems.push('lexicon.terms 为空')
for (const term of draft.lexicon?.terms ?? []) {
  if (typeof term.canonical !== 'string' || !Array.isArray(term.aliases)) problems.push(`lexicon 词条形态非法：${JSON.stringify(term).slice(0, 60)}`)
}
if (!Array.isArray(draft.lexicon?.query_expansion) || draft.lexicon.query_expansion.length === 0) problems.push('lexicon.query_expansion 为空')
if (!Array.isArray(draft.benchmarks?.benchmarks) || draft.benchmarks.benchmarks.length === 0) problems.push('benchmarks.benchmarks 为空')
if (!Array.isArray(draft.benchmarks?.metrics) || draft.benchmarks.metrics.length === 0) problems.push('benchmarks.metrics 为空')
if (!Array.isArray(draft.benchmarks?.required_protocols) || draft.benchmarks.required_protocols.length === 0) problems.push('benchmarks.required_protocols 为空')

const scoring = draft.scoring
const dimensions = scoring?.dimensions ?? {}
const weightSum = Object.values(dimensions).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
if (weightSum !== 100) problems.push(`scoring.dimensions 权重之和应为 100，实测 ${weightSum}`)
for (const key of ['novelty_problem', 'novelty_method', 'novelty_combo', 'feasibility']) {
  if (typeof dimensions[key] !== 'number') problems.push(`scoring.dimensions.${key} 缺失或非数字`)
}
if (typeof scoring?.thresholds?.high_risk_similarity !== 'number') problems.push('scoring.thresholds.high_risk_similarity 缺失')
if (typeof scoring?.thresholds?.topk !== 'number') problems.push('scoring.thresholds.topk 缺失')
const bands = scoring?.suggestion_bands ?? {}
for (const key of ['proceed', 'revise', 'abandon']) {
  const band = bands[key]
  if (!Array.isArray(band) || band.length !== 2 || band.some((value) => typeof value !== 'number')) {
    problems.push(`scoring.suggestion_bands.${key} 必须是 [min,max]`)
  }
}
// 档位必须首尾相接、覆盖 0–100（否则会出现「落不进任何档」的分数）
const ordered = ['abandon', 'revise', 'proceed'].map((key) => bands[key])
if (ordered.every((band) => Array.isArray(band) && band.length === 2)) {
  if (ordered[0][0] !== 0) problems.push(`建议档位未从 0 开始（abandon 下界 ${ordered[0][0]}）`)
  if (ordered[2][1] !== 100) problems.push(`建议档位未到 100（proceed 上界 ${ordered[2][1]}）`)
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i][0] !== ordered[i - 1][1] + 1) {
      problems.push(`建议档位不连续：${ordered[i - 1]} → ${ordered[i]}`)
    }
  }
}

const contract = {
  ref: draft.ref,
  seed_papers: draft.seed_papers,
  schema_ext: draft.schema_ext,
  lexicon: draft.lexicon,
  benchmarks: draft.benchmarks,
  scoring: draft.scoring,
}

console.log(`草案：${draftPath}`)
console.log(`  pack：${draft.ref?.pack_id}@${draft.ref?.version}；种子论文 ${draft.seed_papers?.length ?? 0} 篇`)
console.log(`  字段：${['problems', 'methods', 'innovations'].map((store) => `${store} ${Object.keys(draft.schema_ext?.[store] ?? {}).length}`).join('、')}`)
console.log(`  benchmarks ${draft.benchmarks?.benchmarks?.length ?? 0}、metrics ${draft.benchmarks?.metrics?.length ?? 0}、术语 ${draft.lexicon?.terms?.length ?? 0}、改写组 ${draft.lexicon?.query_expansion?.length ?? 0}`)
console.log(`  权重：${JSON.stringify(dimensions)}（合计 ${weightSum}）；档位：${JSON.stringify(bands)}`)

if (problems.length > 0) {
  console.error(`\n✗ 契约校验未通过（${problems.length} 条）：`)
  for (const item of problems) console.error(`  - ${item}`)
  process.exit(1)
}
console.log('\n✓ 契约校验通过')

const outPath = `data/packs/${draft.ref.pack_id}-${draft.ref.version}.json`
if (dryRun) {
  console.log(`\nDRY RUN —— 未冻结。将写入 ${outPath}，并把 (${PROJECT_ID}) 绑定到该版本。`)
  process.exit(0)
}

if (reviewer === undefined || reviewer.trim() === '') {
  console.error('\n✗ 冻结必须带评审人签名：--reviewer "<你的标识>"。')
  console.error('  （空签名等同于跳过人工评审；v1.2 §3.4.4 规定该步在任何模式下都不可豁免）')
  process.exit(2)
}

// 已冻结的版本拒绝覆盖：改 pack 必须 bump 版本（v1.2 §3.4.4）
try {
  await access(outPath, constants.F_OK)
  console.error(`\n✗ 版本 ${draft.ref.version} 已冻结（${outPath} 已存在）。`)
  console.error('  修改已冻结的 pack 必须升版本（例如 0.2），旧项目仍绑旧版本。')
  process.exit(2)
} catch {
  // 不存在 = 可以冻结
}

const frozenAt = new Date().toISOString()
const frozen = freezeDomainPack(contract, reviewer, frozenAt)

await mkdir('data/packs', { recursive: true })
await writeFile(outPath, `${JSON.stringify(frozen, null, 2)}\n`)

const database = new PaperDatabase('data/papers/metadata.db')
database.raw
  .prepare('INSERT OR REPLACE INTO domain_packs (pack_id, version, frozen_by, frozen_at, pack_path) VALUES (?, ?, ?, ?, ?)')
  .run(frozen.ref.pack_id, frozen.ref.version, frozen.frozen_by, frozen.frozen_at, resolve(outPath))
if (bind) {
  database.raw
    .prepare('INSERT OR REPLACE INTO project_pack_binding (project_id, pack_id, version) VALUES (?, ?, ?)')
    .run(PROJECT_ID, frozen.ref.pack_id, frozen.ref.version)
}
const registered = database.raw.prepare('SELECT pack_id, version, frozen_by, frozen_at FROM domain_packs').all()
const bindings = database.raw.prepare('SELECT project_id, pack_id, version FROM project_pack_binding').all()
database.close()

console.log(`\n✓ 已冻结：${outPath}`)
console.log(`  frozen_by=${frozen.frozen_by}  frozen_at=${frozen.frozen_at}`)
console.log(`  注册表 domain_packs：${JSON.stringify(registered)}`)
console.log(`  绑定 project_pack_binding：${JSON.stringify(bindings)}${bind ? '' : '（未 --bind）'}`)
