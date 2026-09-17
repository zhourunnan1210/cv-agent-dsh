/** 打印 pack 草案的评审要点（逐节，紧凑）。 */
import { readFile } from 'node:fs/promises'

const path = process.argv[2] ?? 'data/packs/deepfake-detection-0.1.draft.json'
const draft = JSON.parse(await readFile(path, 'utf8'))

console.log(`pack ${draft.ref.pack_id}@${draft.ref.version}（种子论文 ${draft.seed_papers.length} 篇）`)
console.log(`\n【schema_ext】每个字段 = 该库条目 ext 里的领域扩展键`)
for (const [store, fields] of Object.entries(draft.schema_ext)) {
  console.log(`  ${store}:`)
  for (const [field, spec] of Object.entries(fields)) {
    const values = spec.type === 'enum' ? `  enum[${spec.values.length}] = ${spec.values.join(' | ')}` : `  ${spec.type}`
    console.log(`    - ${field}${values}`)
  }
}
console.log(`\n【benchmarks】数据集（≥2 篇提及）`)
for (const item of draft.benchmarks.benchmarks) console.log(`    - ${item.name}${item.metric_protocol ? '  (含口径说明)' : ''}`)
console.log(`  指标（≥2 次）：${draft.benchmarks.metrics.join(' | ')}`)
console.log(`  必需协议：${draft.benchmarks.required_protocols.map((p) => p.name).join(' | ')}`)
console.log(`\n【lexicon】术语 ${draft.lexicon.terms.length} 条（本领域检索归一化用）`)
for (const term of draft.lexicon.terms) console.log(`    - ${term.canonical} ← ${term.aliases.slice(0, 4).join(', ')}${term.aliases.length > 4 ? ` …(+${term.aliases.length - 4})` : ''}`)
console.log(`  检索改写组 ${draft.lexicon.query_expansion.length} 组：`)
for (const group of draft.lexicon.query_expansion) console.log(`    - ${group.join(' ~ ')}`)
console.log(`\n【scoring】`)
console.log(`  权重：${JSON.stringify(draft.scoring.dimensions)}（合计 ${Object.values(draft.scoring.dimensions).reduce((a, b) => a + b, 0)}）`)
console.log(`  阈值：${JSON.stringify(draft.scoring.thresholds)}`)
console.log(`  档位：${JSON.stringify(draft.scoring.suggestion_bands)}`)
console.log(`\n【provenance】派生依据`)
// 旧草案（`bootstrap-pack.mjs` 只写 draft 的那个版本）没有这一段。**不要崩**——
// 评审工具在最需要它的时候挂掉，等于把"为什么纳入这些 benchmark"彻底藏起来。
const p = draft.provenance
if (p === undefined) {
  console.log('  ⚠️ 这份草案里没有 provenance（生成它的脚本版本较旧）。')
  console.log('     重新派生一次即可带上：node scripts/bootstrap-pack.mjs --out <同一路径>')
} else {
  console.log(`  论文 ${p.papers} 篇${p.parsed_papers === undefined ? '' : `（已解析 ${p.parsed_papers}）`}、提取 ${p.extractions} 篇、四库条目 ${JSON.stringify(p.entries)}`)
  // 两组全量是评审重点：纳入表只列"够格进 pack"的，排除表列"看着像但不是本领域"的；
  // 评审要问的是"有没有该进没进的"，那必须看见全部观测值。
  console.log(`  benchmark 全量（含只出现 1 次的）：${(p.all_benchmark_names ?? []).join(', ') || '(无)'}`)
  console.log(`  纳入 pack 的 benchmark：${(p.included_benchmarks ?? []).join(', ') || '(无)'}`)
  console.log(`  被排除的通用视觉数据集/预训练语料：${(p.excluded_non_deepfake_benchmarks ?? []).join(', ') || '(无)'}`)
  console.log(`  高频 metric：${(p.top_metrics ?? []).join(', ') || '(无)'}`)
  console.log(`  高频 baseline：${(p.top_baselines ?? []).join(', ') || '(无)'}`)
}
