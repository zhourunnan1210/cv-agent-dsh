/**
 * 模块清单的验收脚本（整合设计 v1.0 §9 第 2 步的判据）。
 *
 * 用法：
 *   node scripts/check-modules.mjs              # 全库自检
 *   node scripts/check-modules.mjs <关键词>      # 按关键词检索模块（撞车"模块轴"的手感测试）
 *
 * 判据：
 *   1. 模块数 ≥ 69（从现有 innovations 派生，一条不落）；
 *   2. 每条模块都能指回 `origin_innovations` 与来源论文（可追溯链完整）；
 *   3. 归一化名无重复（合并规则生效）；
 *   4. 检索两条路径（FTS trigram / LIKE 回退）都能命中。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + 'package.json')

const { KbService } = await import(pathToFileURL('packages/dsh-plugin/lib/kb/service.js').href)
const { normalizeTitle } = await import(pathToFileURL('packages/core/lib/index.js').href)
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

const keyword = process.argv[2]
if (keyword !== undefined) {
  const hits = kb.searchModules({ query: keyword, limit: 8 })
  console.log(`检索模块「${keyword}」：命中 ${hits.length} 条`)
  for (const module of hits) {
    console.log(`  ${module.module_id}  [${module.kinds.join(',') || '未分类'}]  ${module.name}`)
    console.log(`      来源论文 ${module.origin_papers.length} 篇 | 派生自 ${module.origin_innovations.join(',') || '(无)'}`)
    console.log(`      ${module.statement.slice(0, 90)}…`)
  }
  kb.close()
  process.exit(0)
}

console.log('=== 1) 规模与可追溯性 ===')
const innovations = kb.database.raw.prepare('SELECT COUNT(*) AS c FROM innovations').get().c
console.log(`  innovations ${innovations} 条 → modules ${kb.moduleCount()} 条`)
console.log(kb.moduleCount() >= innovations ? '  ✓ 一条不落' : `  ✗ 少了 ${innovations - kb.moduleCount()} 条`)

const noInnovation = kb.database.raw.prepare("SELECT COUNT(*) AS c FROM modules WHERE origin_innovations = '[]'").get().c
const noPaper = kb.database.raw.prepare("SELECT COUNT(*) AS c FROM modules WHERE origin_papers = '[]'").get().c
console.log(`  无派生来源（origin_innovations 为空）：${noInnovation} 条 ${noInnovation === 0 ? '✓' : '✗'}`)
console.log(`  无来源论文（origin_papers 为空）：${noPaper} 条 ${noPaper === 0 ? '✓' : '✗'}`)

console.log('\n=== 2) 归一化名无重复（合并规则生效）===')
const all = kb.database.raw.prepare('SELECT module_id, name FROM modules ORDER BY module_id').all()
const byNormalized = new Map()
const duplicates = []
for (const row of all) {
  const key = normalizeTitle(row.name)
  if (byNormalized.has(key)) duplicates.push(`${row.module_id} 与 ${byNormalized.get(key)} 同名：「${row.name}」`)
  else byNormalized.set(key, row.module_id)
}
console.log(`  ${all.length} 条模块、${byNormalized.size} 个不同的归一化名`)
console.log(duplicates.length === 0 ? '  ✓ 无重复' : `  ✗ ${duplicates.length} 组重复：\n      ${duplicates.slice(0, 5).join('\n      ')}`)

console.log('\n=== 3) 检索两条路径 ===')
const probes = ['频域', '注意力', '回放', 'loss']
for (const probe of probes) {
  const hits = kb.searchModules({ query: probe, limit: 5 })
  console.log(`  「${probe}」→ ${hits.length} 条  ${hits.slice(0, 2).map((m) => m.name.slice(0, 20)).join(' / ')}`)
}

console.log('\n=== 4) 模块 ↔ 论文 双向 ===')
const sample = kb.searchModules({ limit: 3 })
for (const module of sample) {
  const papers = kb.papersOfModule(module.module_id)
  const back = papers.length > 0 ? kb.modulesOfPaper(papers[0]).length : 0
  console.log(`  ${module.module_id}「${module.name.slice(0, 24)}」→ ${papers.length} 篇；反查首篇 → ${back} 个模块`)
}

console.log('\n=== 5) 分布 ===')
const kindCounts = new Map()
for (const row of all) {
  for (const kind of JSON.parse(kb.database.raw.prepare('SELECT kinds FROM modules WHERE module_id = ?').get(row.module_id).kinds)) {
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1)
  }
}
console.log(`  按类别：${[...kindCounts.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
const perPaper = kb.database.raw.prepare('SELECT paper_id, COUNT(*) AS c FROM module_sources GROUP BY paper_id ORDER BY c DESC').all()
console.log(`  每篇论文的模块数（前 5）：${perPaper.slice(0, 5).map((r) => `${r.paper_id.slice(-12)}=${r.c}`).join('  ')}`)
console.log(`  覆盖论文 ${perPaper.length} 篇；平均 ${(all.length / Math.max(1, perPaper.length)).toFixed(1)} 个模块/篇`)
kb.close()
