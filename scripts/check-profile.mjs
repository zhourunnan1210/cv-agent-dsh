import { resolveDshModules, resolveDshPackage } from './lib/dsh-root.mjs'
/**
 * 论文画像与反向索引的验收脚本（整合设计 v1.0 §9 第 1 步的判据）。
 *
 * 用法：
 *   node scripts/check-profile.mjs                 # 全库自检（索引完整性 + 抽样画像）
 *   node scripts/check-profile.mjs <paper_id>      # 打印指定论文的完整画像
 *
 * 判据（来自设计文档）：
 *   1. 反向索引里的关联数 == 四库 `source_papers` 展开后的关联数（迁移回填无损）；
 *   2. 任取一篇论文，画像能一次组装出 L1 + L2 + L3，且条目带 shared_with；
 *   3. 单次画像组装 < 10ms。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH = resolveDshModules()
const require = createRequire(DSH + 'package.json')

const { KbService } = await import(pathToFileURL('packages/dsh-plugin/lib/kb/service.js').href)
const { STORE_NAMES } = await import(pathToFileURL('packages/core/lib/schema/kb.js').href)
const systemPrompt = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

const app = new cordis.Context()
await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPrompt.default) } })
let kb
await app.plugin({
  name: 'core',
  inject: ['systemPrompt'],
  apply(ctx) { kb = new KbService(ctx, { dbPath: 'data/papers/metadata.db' }) },
})

const paperId = process.argv[2]

if (paperId !== undefined) {
  const profile = kb.getPaperProfile(paperId)
  if (profile === undefined) {
    console.error(`论文不存在：${paperId}`)
    process.exit(1)
  }
  console.log(`论文画像：${profile.paper_id}`)
  console.log(`\n[L1 元数据]`)
  for (const [key, value] of Object.entries(profile.meta)) console.log(`  ${key}: ${value}`)
  console.log(`\n[L2 提取]`)
  if (profile.extraction === undefined) {
    console.log('  （尚未提取）')
  } else {
    const e = profile.extraction
    console.log(`  problem_statement (${e.problem_statement.length} 字): ${e.problem_statement.slice(0, 100)}…`)
    console.log(`  method_summary    (${e.method_summary.length} 字): ${e.method_summary.slice(0, 100)}…`)
    console.log(`  innovations: ${e.innovations.length} 条`)
    console.log(`  limitations: ${e.limitations.length} 条 | benchmarks: ${e.benchmarks.length} 个 | baselines: ${e.baseline_methods.length} 个`)
  }
  console.log(`\n[L3 条目]  合计 ${profile.entry_total} 条`)
  for (const store of STORE_NAMES) {
    const list = profile.entries[store]
    console.log(`  ${store} (${list.length} 条)：`)
    for (const entry of list) {
      const shared = entry.shared_with === 0 ? '本篇独有' : `与另外 ${entry.shared_with} 篇共享`
      console.log(`      ${entry.entry_id}  [${shared}]  ${entry.statement.slice(0, 70)}…`)
    }
  }
  kb.close()
  process.exit(0)
}

// ── 全库自检 ──────────────────────────────────────────────────────────────
console.log('=== 1) 反向索引完整性（迁移回填是否无损）===')
let expected = 0
for (const store of STORE_NAMES) {
  const rows = kb.database.raw.prepare(`SELECT source_papers FROM ${store}`).all()
  for (const row of rows) expected += JSON.parse(row.source_papers).length
}
const actual = kb.database.raw.prepare('SELECT COUNT(*) AS c FROM entry_sources').get().c
console.log(`  四库 source_papers 展开后应有 ${expected} 条关联`)
console.log(`  entry_sources 实际有       ${actual} 条关联`)
// 表的主键是 (paper_id, store, entry_id)，重复行插不进去，所以不必再查去重计数。
console.log(expected === actual
  ? '  ✓ 索引完整（主键保证无重复）'
  : `  ✗ 不一致（差 ${expected - actual}）`)

console.log('\n=== 2) 抽样：有提取的论文，画像是否三层齐全 ===')
const extracted = kb.database.raw.prepare('SELECT paper_id FROM paper_extractions ORDER BY paper_id LIMIT 3').all()
for (const { paper_id } of extracted) {
  const profile = kb.getPaperProfile(paper_id)
  const stores = STORE_NAMES.map((store) => `${store}=${profile.entries[store].length}`).join(' ')
  console.log(`  ${paper_id}`)
  console.log(`      L2 ${profile.extraction === undefined ? '缺失 ✗' : '✓'} | L3 合计 ${profile.entry_total} 条（${stores}）`)
}

console.log('\n=== 3) 性能：单次画像组装 ===')
const samples = kb.database.raw.prepare('SELECT paper_id FROM papers LIMIT 50').all().map((r) => r.paper_id)
const started = process.hrtime.bigint()
for (const id of samples) kb.getPaperProfile(id)
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
console.log(`  ${samples.length} 次组装共 ${elapsedMs.toFixed(1)}ms → 平均 ${(elapsedMs / samples.length).toFixed(2)}ms/次`)
console.log(elapsedMs / samples.length < 10 ? '  ✓ 满足 < 10ms 判据' : '  ✗ 超出 10ms')

console.log('\n=== 4) 问题簇展开（撞车"问题轴"原语）===')
const clusters = kb.database.raw.prepare('SELECT entry_id, statement, source_papers FROM problems ORDER BY entry_id').all()
for (const cluster of clusters.slice(0, 5)) {
  const papers = kb.papersSharingProblem(cluster.entry_id)
  console.log(`  ${cluster.entry_id}  ${papers.length} 篇  ${cluster.statement.slice(0, 50)}…`)
}
console.log(`  （问题库共 ${clusters.length} 个簇）`)
kb.close()
