/**
 * 向量口径阈值的**实测校准**（整合设计 v1.0 §9.3）。
 *
 * ## 要回答的问题
 *
 * core 里有两套阈值口径：
 * - keyword_only：边界带 `[0.10, 0.30)`、near-dup `0.30` —— 注释写明"实测校准"；
 * - vector：边界带 `[0.70, 0.90)`、near-dup = pack 的 `high_risk_similarity`（0.85）
 *   —— **没有实测记录**，是照余弦尺度估的。
 *
 * 这个脚本把向量那组量出来。不量就用，等于把"估的数"当成"校准的数"——
 * 而勘误 §11.5 的整个教训就是这件事（trigram 的 0.012 也曾被当成有语义的数）。
 *
 * ## 标注从哪来（关键：不靠人工标，靠库自身的结构）
 *
 * 相似度的用途是回答"两条条目是不是同一件事"。库自己给出了这个标注：
 * - **正例**：两条条目**共享至少一篇论文** —— 库在说"它们出自同一批工作"；
 * - **负例**：两条条目**没有任何共同论文** —— 库在说"它们互不相干"。
 *
 * 这个标注是客观、可复现的，但要说清它的**局限**：共享论文 ≠ 一定同义
 * （一篇论文可以有一个频域问题和一个算力问题）。所以正例里的低分不必然是"漏报"，
 * 也可能是"确实不同"——脚本会把正例分布的两端都打出来，让这个含糊之处可见。
 *
 * ## 用法
 *
 *   node scripts/calibrate-vector-thresholds.mjs [--store problems|methods|innovations|modules] [--max 400]
 *
 * 只读打开数据库，不写任何东西。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + 'package.json')

const { KbService } = await import(pathToFileURL('packages/dsh-plugin/lib/kb/service.js').href)
const { loadLocalEmbedder, cosine, probeModelCache } = await import(
  pathToFileURL('packages/dsh-plugin/lib/scoring/embedding.js').href
)
const systemPrompt = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const STORES = (arg('store', 'problems,methods')).split(',')
const MAX_PER_STORE = Number(arg('max', '400'))

const CACHE = 'data/models'
const probe = await probeModelCache(CACHE)
if (!probe.ready) {
  console.error(`模型未缓存（缺 ${probe.missing.join('、')}）——先按 §9.2 手工下载。`)
  process.exit(1)
}
const backend = await loadLocalEmbedder({ cacheDir: CACHE })
if (backend === undefined) {
  console.error('模型已缓存但加载失败：检查 optionalDependencies 与 ONNX 文件。')
  process.exit(1)
}

const app = new cordis.Context()
await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPrompt.default) } })
let kb
await app.plugin({
  name: 'core',
  inject: ['systemPrompt'],
  apply(ctx) { kb = new KbService(ctx, { dbPath: 'data/papers/metadata.db' }) },
})

/**
 * 读某库全部条目（含各自论文集合）。
 *
 * `modules` 不在 `entries` 表里（它是独立的模块清单，§9 第 2 步建的），
 * 所以走 `searchModules` 的无查询全量路径；其余四个库走 `listEntries`。
 */
function entriesOf(store) {
  if (store === 'modules') {
    return kb.searchModules({ limit: MAX_PER_STORE }).map((module) => ({
      entry_id: module.module_id,
      statement: `${module.name}｜${module.statement}`,
      papers: kb.papersOfModule(module.module_id),
    }))
  }
  return kb.listEntries()
    .filter((entry) => entry.store === store)
    .slice(0, MAX_PER_STORE)
    .map((entry) => ({
      entry_id: entry.entry_id,
      statement: String(entry.statement),
      papers: kb.papersOfEntry(store, entry.entry_id),
    }))
}

/** 取分位数（线性插值）。 */
function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

const describe = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    min: quantile(sorted, 0),
    p05: quantile(sorted, 0.05),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    max: quantile(sorted, 1),
  }
}

const show = (label, stats) => {
  console.log(
    `${label.padEnd(10)} n=${String(stats.n).padStart(4)}  `
    + `min ${stats.min.toFixed(3)}  p05 ${stats.p05.toFixed(3)}  p25 ${stats.p25.toFixed(3)}  `
    + `p50 ${stats.p50.toFixed(3)}  p75 ${stats.p75.toFixed(3)}  p95 ${stats.p95.toFixed(3)}  max ${stats.max.toFixed(3)}`,
  )
}

console.log(`模型：${backend.model}（${backend.dtype}）`)
console.log(`库位：${STORES.join(', ')}   每库上限 ${MAX_PER_STORE} 条\n`)

/** 全部结论收集起来，最后统一给判读。 */
const findings = []

for (const store of STORES) {
  const entries = entriesOf(store)
  if (entries.length < 4) {
    console.log(`【${store}】条目不足（${entries.length} 条），跳过\n`)
    continue
  }

  // 一次批量编码整个库位
  const vectors = await backend.embed(entries.map((entry) => entry.statement))

  const positive = []
  const negative = []
  const positivePairs = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const shared = entries[i].papers.filter((paper) => entries[j].papers.includes(paper))
      const score = cosine(vectors[i], vectors[j])
      if (shared.length > 0) {
        positive.push(score)
        positivePairs.push({ a: entries[i], b: entries[j], score, shared })
      } else {
        negative.push(score)
      }
    }
  }

  const pos = describe(positive)
  const neg = describe(negative)
  console.log(`【${store}】${entries.length} 条 → 正例（共享论文）${pos.n} 对，负例 ${neg.n} 对`)
  show('  正例', pos)
  show('  负例', neg)

  // 用扫描找最佳分离阈值（Youden's J = TPR − FPR）
  let best = { threshold: 0, j: -2 }
  for (let threshold = 0; threshold <= 1.0001; threshold += 0.01) {
    const tpr = positive.filter((score) => score >= threshold).length / Math.max(1, positive.length)
    const fpr = negative.filter((score) => score >= threshold).length / Math.max(1, negative.length)
    const j = tpr - fpr
    if (j > best.j) best = { threshold: Number(threshold.toFixed(2)), j, tpr, fpr }
  }
  console.log(
    `  最佳分离阈值 ${best.threshold.toFixed(2)}  `
    + `（正例召回 ${(best.tpr * 100).toFixed(1)}%，负例误报 ${(best.fpr * 100).toFixed(1)}%，J=${best.j.toFixed(3)}）`,
  )

  // 现有向量口径的实测表现
  const BAND = [0.7, 0.9]
  const NEAR = 0.85
  const bandMissed = positive.filter((score) => score < BAND[0]).length / Math.max(1, positive.length)
  const bandCaught = positive.filter((score) => score >= BAND[0] && score < BAND[1]).length / Math.max(1, positive.length)
  const negInBand = negative.filter((score) => score >= BAND[0]).length / Math.max(1, negative.length)
  const negNear = negative.filter((score) => score >= NEAR).length / Math.max(1, negative.length)
  console.log(
    `  现口径 边界带 [${BAND[0]}, ${BAND[1]})：正例落在带内 ${(bandCaught * 100).toFixed(1)}%，`
    + `低于带下沿（**不会被外扩**）${(bandMissed * 100).toFixed(1)}%`,
  )
  console.log(
    `  现口径 near-dup ${NEAR}：负例被判 high 的比例 ${(negNear * 100).toFixed(2)}%；`
    + `负例落在 ≥${BAND[0]} 的比例 ${(negInBand * 100).toFixed(2)}%`,
  )

  // 高分正例样本（人眼复核"它俩到底像不像"）
  const top = [...positivePairs].sort((a, b) => b.score - a.score).slice(0, 3)
  console.log('  正例最高分 3 对：')
  for (const pair of top) {
    console.log(`    ${pair.score.toFixed(3)} ${pair.a.entry_id}「${pair.a.statement.slice(0, 34)}」`)
    console.log(`          ${pair.b.entry_id}「${pair.b.statement.slice(0, 34)}」 共享论文 ${pair.shared.join(',')}`)
  }
  const low = [...positivePairs].sort((a, b) => a.score - b.score).slice(0, 3)
  console.log('  正例最低分 3 对（低分不必然是漏报——共享论文 ≠ 同义）：')
  for (const pair of low) {
    console.log(`    ${pair.score.toFixed(3)} ${pair.a.entry_id}「${pair.a.statement.slice(0, 34)}」`)
    console.log(`          ${pair.b.entry_id}「${pair.b.statement.slice(0, 34)}」`)
  }
  console.log('')

  findings.push({ store, pos, neg, best, bandMissed, negNear, negInBand })
}

console.log('─'.repeat(100))
console.log('排序 A/B（这才是 4b 实际用到 embedding 的地方：只排序，不设绝对阈值）')
console.log('判据：留一法，用每条条目自己的 statement 作查询，看 top-1 / top-5 里有多少条与它共享论文。')
console.log('      共享论文只是**相关性的代理标注**（弱标注，见文件头），所以看的是"语义排序是否比字面排序更常命中"。\n')

const { lexicalSimilarity } = await import(pathToFileURL('packages/core/lib/index.js').href)

for (const store of STORES) {
  const entries = entriesOf(store)
  if (entries.length < 4) continue
  const vectors = await backend.embed(entries.map((entry) => entry.statement))

  const evaluate = (rankOf) => {
    let hit1 = 0
    let hit5 = 0
    let total = 0
    for (let i = 0; i < entries.length; i += 1) {
      const scored = entries
        .map((entry, j) => ({ j, score: j === i ? -Infinity : rankOf(i, j) }))
        .sort((a, b) => b.score - a.score)
      const relevant = (j) => entries[i].papers.some((paper) => entries[j].papers.includes(paper))
      if (relevant(scored[0].j)) hit1 += 1
      if (scored.slice(0, 5).some((item) => relevant(item.j))) hit5 += 1
      total += 1
    }
    return { hit1, hit5, total }
  }

  const semantic = evaluate((i, j) => cosine(vectors[i], vectors[j]))
  const lexical = evaluate((i, j) => lexicalSimilarity(entries[i].statement, entries[j].statement))
  const pct = (value, total) => `${((value / Math.max(1, total)) * 100).toFixed(1)}%`

  console.log(`【${store}】${entries.length} 条`)
  console.log(`  语义（余弦）  precision@1 ${pct(semantic.hit1, semantic.total)}   recall@5 ${pct(semantic.hit5, semantic.total)}`)
  console.log(`  字面（trigram）precision@1 ${pct(lexical.hit1, lexical.total)}   recall@5 ${pct(lexical.hit5, lexical.total)}`)
  console.log('')
}

console.log('─'.repeat(100))
console.log('判读：')
for (const found of findings) {
  const separated = found.pos.p50 > found.neg.p95
  console.log(
    `  ${found.store}: ${separated ? '两类分布分离（正例中位数 > 负例 p95）' : '⚠ 两类分布重叠（正例中位数 ≤ 负例 p95）'}；`
    + `最佳阈值 ${found.best.threshold.toFixed(2)}，`
    + `现有 0.85 的负例误判率 ${(found.negNear * 100).toFixed(2)}%`,
  )
}
kb.close()
