import { resolveDshModules, resolveDshPackage } from './lib/dsh-root.mjs'
/**
 * 从现有 `innovations` 派生模块清单初值（整合设计 v1.0 §3.5 / §10 开放项 4）。
 *
 * ## 为什么不重提取旧论文
 *
 * 21 篇已提取论文里的 `innovations` 本来就是**可命名机制**（3–6 条/篇，43–148 字，
 * 带 `innovation_type`）。让 21 篇重跑一次 Reader 只为拿一个新字段，成本远大于收益，
 * 而且要重跑满 21 次子代理委派。所以初值直接派生，新论文按新契约（含 `method_modules`）
 * 提取后由 Analyst 汇入同一份清单。
 *
 * ## 幂等
 *
 * 走 `kb.upsertModule`（归一化名命中即合并），所以**可以反复跑**：
 * 第二次跑只会把来源论文与 kinds 取并集，不会产生重复模块。
 *
 * 用法：node scripts/seed-modules.mjs [--dry-run]
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH = resolveDshModules()
const require = createRequire(DSH + 'package.json')

const { KbService } = await import(pathToFileURL('packages/dsh-plugin/lib/kb/service.js').href)
const systemPrompt = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

const dryRun = process.argv.includes('--dry-run')

const app = new cordis.Context()
await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPrompt.default) } })
let kb
await app.plugin({
  name: 'core',
  inject: ['systemPrompt'],
  apply(ctx) { kb = new KbService(ctx, { dbPath: 'data/papers/metadata.db' }) },
})

/**
 * innovations 条目的模块名：取 statement 里**第一个全角冒号 / 破折号之前**的短语。
 *
 * ⚠️ 分隔符只认 `：` `:` 与 `——`，**不能把 ASCII 连字符 `-` 当分隔符**：
 * 真实数据里 "空间-频率混合感知模块（SFHA）：…" 会被切成「空间」，
 * "AAML（Authenticity-Aware Margin Loss）：…" 会被切成「AAML（Authenticity」——
 * dry-run 第一次跑就是这么暴露出来的。连字符在英文术语与中文复合词里都是**词内字符**。
 */
function moduleNameOf(statement) {
  const head = statement.split(/[：:]|——/)[0].trim()
  const candidate = head.length >= 2 && head.length <= 48 ? head : statement.slice(0, 28).trim()
  return candidate.replace(/\s+/g, ' ').trim()
}

/** innovations 的 `innovation_type`（new_method / new_loss / …）映射到模块 kind。 */
function kindOf(innovationType) {
  switch (innovationType) {
    case 'new_loss': return 'loss'
    case 'new_dataset': return 'dataset'
    case 'new_benchmark': return 'protocol'
    case 'new_method':
    case 'new_framework': return 'module'
    default: return 'other'
  }
}

console.log(`模块清单派生${dryRun ? '（DRY RUN）' : ''}`)
console.log(`  现有模块：${kb.moduleCount()} 条`)

const innovations = kb.database.raw.prepare('SELECT entry_id, statement, ext, source_papers FROM innovations ORDER BY entry_id').all()
let created = 0
let merged = 0
let withCandidates = 0

for (const row of innovations) {
  const ext = JSON.parse(row.ext)
  const packFields = Object.values(ext)[0] ?? {}
  const innovationType = typeof packFields.innovation_type === 'string' ? packFields.innovation_type : undefined
  const papers = JSON.parse(row.source_papers)
  const name = moduleNameOf(row.statement)
  if (dryRun) {
    console.log(`  [dry] ${row.entry_id} → 「${name}」 kind=${kindOf(innovationType)} 来源 ${papers.length} 篇`)
    continue
  }
  const outcome = kb.upsertModule({
    name,
    statement: row.statement,
    kinds: [kindOf(innovationType)],
    ...(papers.length > 0 ? { paper_id: papers[0] } : {}),
    innovation_id: row.entry_id,
    ext: { seeded_from: 'innovations' },
  })
  if (outcome.merged) merged += 1
  else created += 1
  // 只有一篇来源论文的条目才登记来源（多来源的 innovation 在库里其实不存在，留个保险）
  for (const paperId of papers.slice(1)) {
    kb.database.raw.prepare('INSERT OR IGNORE INTO module_sources (paper_id, module_id) VALUES (?, ?)').run(paperId, outcome.module_id)
  }
  if (outcome.candidates.length > 0) {
    withCandidates += 1
    console.log(`  ⚠ 「${name}」可能与其他模块同族（交给 Analyst 判定）：${outcome.candidates.map((c) => `${c.module_id}「${c.name}」`).join('、')}`)
  }
}

if (!dryRun) {
  console.log(`\n新建 ${created} 条、合并 ${merged} 条；模块总数 ${kb.moduleCount()}`)
  const unlinked = kb.database.raw.prepare('SELECT COUNT(*) AS c FROM modules WHERE origin_innovations = \'[]\'').get().c
  console.log(`无法追溯来源的模块：${unlinked} 条（应为 0）`)
  console.log(`有同族候选、待 Analyst 判定的：${withCandidates} 条`)
}
kb.close()
