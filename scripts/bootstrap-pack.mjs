/**
 * Domain Pack 草案生成（CLI）。
 *
 * 用法：node scripts/bootstrap-pack.mjs [--pack-id X] [--version Y] [--out path]
 *
 * ⚠️ **派生逻辑只有一份**：本脚本是 `packages/dsh-plugin/src/domain/pack-builder.ts`
 * 的薄壳——会话内的 `cvagent_domain_bootstrap` 工具用的是同一份实现、同一套 SQL
 * （`loadPaperRows` / `loadExtractionIds` / `loadEntryRows`），契约校验也共享。
 *
 * 为什么强调这一点（2026-09-17）：脚本与工具各写一套时，"契约校验"那几十行规则
 * 一旦不一致，就会出现「脚本说能冻、工具说不能」——这类问题最难定位，因为两边
 * 各自看都对。数据源同样统一为 `metadata.db`，不再读中间产物 JSON。
 *
 * 本脚本只生成草案、**不冻结**：冻结必须带人工评审签名（core 的 `freezeDomainPack`
 * 在签名为空时直接抛错）。冻结走 `scripts/freeze-pack.mjs` 或会话内的 `cvagent_domain_freeze`。
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'
import {
  derivePackDraft,
  loadEntryRows,
  loadExtractionIds,
  loadPaperRows,
  loadParsedPaperCount,
  summarizeDraft,
  validatePackDraft,
} from '../packages/dsh-plugin/lib/domain/pack-builder.js'

const args = process.argv.slice(2)
const optValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--') ? args[index + 1] : undefined
}

const packId = optValue('--pack-id') ?? 'deepfake-detection'
const version = optValue('--version') ?? '0.1'
const out = optValue('--out') ?? resolve('data/packs', `${packId}-${version}.draft.json`)

const database = new PaperDatabase('data/papers/metadata.db')
const library = new PaperLibrary(database)

const source = {
  papers: loadPaperRows(database),
  parsedPapers: loadParsedPaperCount(database),
  extractions: loadExtractionIds(database)
    .map((paperId) => library.getExtraction(paperId))
    .filter((extraction) => extraction !== undefined),
  entries: loadEntryRows(database),
}

const { draft, provenance } = derivePackDraft(source, {
  packId,
  version,
  generatedBy: 'scripts/bootstrap-pack.mjs（从 metadata.db 实测派生）',
  packNamespace: optValue('--namespace') ?? packId,
})

await mkdir(dirname(out), { recursive: true })
// ⚠️ **provenance 必须与草案一起落盘**。以前只写 `draft`，于是"为什么纳入/排除这些
// benchmark、从多少篇里派生出来的"只在生成时打印一次就丢了——而人工评审（§12.5）
// 恰恰要看这一段。冻结时 `freezeDraft` 只保留契约字段，所以它不会污染冻结产物。
await writeFile(out, `${JSON.stringify({ ...draft, provenance }, null, 2)}\n`)
const validation = validatePackDraft(draft)
database.close()

const summary = summarizeDraft(draft)
console.log(`Domain Pack 草案已生成：${out}`)
console.log(`  种子论文 ${summary.seed_papers} 篇；schema_ext：` +
  Object.entries(summary.schema_ext_fields).map(([store, fields]) => `${store} ${fields.length} 字段`).join('、'))
console.log(`  benchmarks ${summary.benchmarks} 个、metrics ${summary.metrics} 个、协议 ${summary.protocols} 条`)
console.log(`  lexicon：${summary.lexicon_terms} 术语 / ${summary.query_expansion_groups} 改写组`)
console.log(`  权重：${JSON.stringify(summary.dimensions)}（阈值：${JSON.stringify(summary.thresholds)}）`)
console.log(`\n纳入的 benchmark（归一并计数，共 ${provenance.included_benchmarks.length} 个）：`)
for (const item of provenance.included_benchmarks) console.log(`  ${item}`)
console.log(`\n排除的非深伪数据集/预训练语料：${provenance.excluded_non_deepfake_benchmarks.join(', ') || '(无)'}`)
console.log(`数据源：论文 ${provenance.papers} 篇、提取 ${provenance.extractions} 篇、条目 ${JSON.stringify(provenance.entries)}`)
console.log(`\n契约校验：${validation.problems.length === 0 ? '通过（可冻结）' : `未通过 ${validation.problems.length} 条`}`)
for (const problem of validation.problems) console.log(`  ✗ ${problem}`)
for (const note of validation.notes) console.log(`  ⚠ ${note}`)
console.log('\n下一步（冻结需人工评审，不可跳过）：')
console.log(`  1) 评审 ${out}`)
console.log(`  2) node scripts/freeze-pack.mjs --reviewer "<你的标识>"`)
console.log('  会话内等价流程：cvagent_domain_bootstrap → cvagent_domain_freeze')
