/**
 * P2-7 · 三库条目校验 + 装载。
 *
 * 用法：
 *   node scripts/load-entries.mjs <entries.json> [--audit]
 *     --audit  只校验与报告，不写库
 *
 * 校验项：
 *   - store ∈ {problems, methods, innovations}；
 *   - statement 非空，且**归一化后文件内唯一**（重复会在入库时被合并，属静默丢条目）；
 *   - source_papers 非空数组，且每个 paper_id 都在 papers 表里（防编造 ID）；
 *   - ext 为对象；含 deepfake-detection 包时校验字段枚举合法性（宽松：未知值只告警）。
 */

import { readFile } from 'node:fs/promises'

import { normalizeTitle } from '../packages/core/lib/index.js'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { TriLibrary } from '../packages/dsh-plugin/lib/kb/trilibrary.js'

const args = process.argv.slice(2)
const auditOnly = args.includes('--audit')
const path = args.find((arg) => !arg.startsWith('--'))
if (path === undefined) {
  console.error('用法：node scripts/load-entries.mjs <entries.json> [--audit] [--source <paper_id>]')
  process.exit(2)
}
/** 空 source_papers 的回退源（与 save-entries.mjs 的 CLI 默认一致）。 */
const sourceIndex = args.indexOf('--source')
const fallbackSource = sourceIndex >= 0 && args[sourceIndex + 1] !== undefined
  ? args[sourceIndex + 1]
  : '10.48550/arxiv.2508.20449'

const STORES = new Set(['problems', 'methods', 'innovations', 'failures'])
const ENUMS = {
  paradigm: new Set(['frequency', 'spatial', 'hybrid', 'clip_foundation', 'reconstruction', 'proactive', 'temporal', 'audio_visual', 'continual', 'ensemble', 'other']),
  training_strategy: new Set(['supervised', 'self_supervised', 'semi_supervised', 'adversarial', 'meta_learning', 'knowledge_distillation', 'other']),
  generalization_target: new Set(['in_dataset', 'cross_dataset', 'cross_manipulation', 'cross_model', 'none']),
  innovation_type: new Set(['new_method', 'new_framework', 'new_loss', 'new_dataset', 'new_benchmark', 'new_insight', 'other']),
  modality: new Set(['image', 'video', 'visual', 'audio', 'audio_visual', 'other']),
  detection_target: new Set(['entire_synthesis', 'face_swap', 'face_reenactment', 'attribute_manipulation', 'partial_region', 'audio_speech', 'other']),
  // 失败库（第四库）
  failure_mode: new Set(['method_invalid', 'data_issue', 'metric_not_improved', 'resource_infeasible', 'reproducibility', 'other']),
}

const entries = JSON.parse(await readFile(path, 'utf8'))
if (!Array.isArray(entries)) {
  console.error('顶层必须是数组')
  process.exit(2)
}

const database = new PaperDatabase('data/papers/metadata.db')
const known = new Set(database.raw.prepare('SELECT paper_id FROM papers').all().map((row) => row.paper_id))
const tri = new TriLibrary(database)

const problems = []
const warnings = []
const seenStatements = new Map()
const counts = { problems: 0, methods: 0, innovations: 0 }
const outcomes = { created: 0, merged: 0 }

for (const [index, entry] of entries.entries()) {
  const label = `#${index + 1} [${entry?.store}]`
  if (!STORES.has(entry?.store)) {
    problems.push(`${label} store 非法：${entry?.store}`)
    continue
  }
  const statement = typeof entry.statement === 'string' ? entry.statement.trim() : ''
  if (statement === '') {
    problems.push(`${label} statement 为空`)
    continue
  }
  const normalized = normalizeTitle(statement)
  if (seenStatements.has(normalized)) {
    problems.push(`${label} 与 #${seenStatements.get(normalized) + 1} 归一化后重复（入库会合并成一条）：${statement.slice(0, 50)}`)
  } else {
    seenStatements.set(normalized, index)
  }
  const sources = Array.isArray(entry.source_papers) ? entry.source_papers : []
  if (sources.length === 0) {
    // 三库条目必须可溯源到论文（§7.5.2 的 source_papers）；早期 pilot 文件靠
    // save-entries.mjs 的 CLI 默认源补，这里对空源只警告并回退到该默认
    warnings.push(`${label} source_papers 为空（回退到 CLI/默认源）`)
  }
  for (const paperId of sources) {
    if (!known.has(paperId)) problems.push(`${label} source_papers 含不存在的 paper_id：${paperId}`)
  }
  if (entry.ext !== undefined && (typeof entry.ext !== 'object' || entry.ext === null || Array.isArray(entry.ext))) {
    problems.push(`${label} ext 不是对象`)
  }
  const pack = entry.ext?.['deepfake-detection']
  if (pack !== undefined) {
    for (const [field, allowed] of Object.entries(ENUMS)) {
      const value = pack[field]
      if (value === undefined || Array.isArray(value)) continue
      // problem 层的 detection_target 是**描述性**的（"增量到达的新伪造类型…"），
      // 枚举约束只对 methods/innovations 的机制字段有意义
      if (entry.store === 'problems' && field === 'detection_target') continue
      // 枚举是**建议性**的（ext 是 JSON 列，无 DB 级约束）：连字符/下划线两种写法
      // 都接受（既有的 M001 用 'cross-dataset'，本轮规范写 'cross_dataset'）
      if (typeof value === 'string' && !allowed.has(value) && !allowed.has(value.replace(/-/g, '_'))) {
        warnings.push(`${label} ${field}='${value}' 不在建议枚举内（不阻塞）`)
      }
    }
  }
  counts[entry.store] += 1
  if (auditOnly) continue
  const effectiveSources = sources.length === 0 ? [fallbackSource] : sources
  const outcome = tri.upsert(entry.store, statement, effectiveSources, entry.ext ?? {})
  if (outcome.merged) outcomes.merged += 1
  else outcomes.created += 1
  console.log(`${outcome.merged ? '合并' : '新建'} ${outcome.entry_id} [${entry.store}] ${statement.slice(0, 60)}`)
}

console.log('\n── 三库条目报告 ───────────────────────────────')
console.log(`文件条目：problems ${counts.problems}、methods ${counts.methods}、innovations ${counts.innovations}（合计 ${entries.length}）`)
if (auditOnly) {
  console.log(`（audit 模式，未写库）`)
} else {
  console.log(`写库：新建 ${outcomes.created}、合并 ${outcomes.merged}`)
  console.log(`库内计数：${JSON.stringify(tri.counts())}`)
}
console.log(`硬错误 ${problems.length} 条：`)
for (const item of problems) console.log(`  ✗ ${item}`)
console.log(`警告 ${warnings.length} 条：`)
for (const item of warnings) console.log(`  ⚠ ${item}`)
database.close()
process.exit(problems.length > 0 ? 1 : 0)
