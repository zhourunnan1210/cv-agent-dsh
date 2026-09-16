/**
 * 相似度标定（P3-3）：用**真实三库条目**测出 `keyword_only` 模式的阈值分布，
 * 而不是拍脑袋定 0.85。
 *
 * 为什么要做：`high_risk_similarity=0.85` 是给 embedding 余弦定的口径；字符 trigram
 * Jaccard 的尺度完全不同（实测"同文不同语序"才 ~0.57），直接套用会**严重漏判撞车**。
 *
 * 方法：
 *   - 正例对：`source_papers` 有交集的条目对（大概率在讲相近的东西）；
 *   - 负例对：`source_papers` 无交集的随机条目对；
 *   - 输出两组的分位数，据此给出 keyword_only 模式的建议阈值与边界带。
 *
 * 用法：node scripts/calibrate-similarity.mjs
 */

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { lexicalSimilarity } from '../packages/core/lib/index.js'

const db = new PaperDatabase('data/papers/metadata.db')

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[index]
}

const report = {}
for (const store of ['problems', 'methods', 'innovations']) {
  const rows = db.raw.prepare(`SELECT entry_id, statement, source_papers FROM ${store}`).all()
  const entries = rows.map((row) => ({ ...row, sources: JSON.parse(row.source_papers) }))

  const positives = []
  const negatives = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const similarity = lexicalSimilarity(entries[i].statement, entries[j].statement)
      const shared = entries[i].sources.some((id) => entries[j].sources.includes(id))
      if (shared) positives.push(similarity)
      else negatives.push(similarity)
    }
  }
  positives.sort((a, b) => a - b)
  negatives.sort((a, b) => a - b)

  report[store] = {
    pairs: positives.length + negatives.length,
    positives: {
      n: positives.length,
      p50: percentile(positives, 50),
      p75: percentile(positives, 75),
      p90: percentile(positives, 90),
      p95: percentile(positives, 95),
      max: positives[positives.length - 1] ?? 0,
    },
    negatives: {
      n: negatives.length,
      p50: percentile(negatives, 50),
      p90: percentile(negatives, 90),
      p99: percentile(negatives, 99),
      max: negatives[negatives.length - 1] ?? 0,
    },
  }
}

// 全局合并（三库一起看）
const all = { positives: [], negatives: [] }
for (const store of ['problems', 'methods', 'innovations']) {
  const rows = db.raw.prepare(`SELECT statement, source_papers FROM ${store}`).all()
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const similarity = lexicalSimilarity(rows[i].statement, rows[j].statement)
      const a = JSON.parse(rows[i].source_papers)
      const b = JSON.parse(rows[j].source_papers)
      if (a.some((id) => b.includes(id))) all.positives.push(similarity)
      else all.negatives.push(similarity)
    }
  }
}
all.positives.sort((x, y) => x - y)
all.negatives.sort((x, y) => x - y)

console.log('按库统计（正例=共享来源论文；负例=不共享）')
for (const [store, stats] of Object.entries(report)) {
  console.log(`\n[${store}] 对数 ${stats.pairs}`)
  console.log(`  正例 n=${stats.positives.n}  p50=${stats.positives.p50} p75=${stats.positives.p75} p90=${stats.positives.p90} p95=${stats.positives.p95} max=${stats.positives.max}`)
  console.log(`  负例 n=${stats.negatives.n}  p50=${stats.negatives.p50} p90=${stats.negatives.p90} p99=${stats.negatives.p99} max=${stats.negatives.max}`)
}

const posP90 = percentile(all.positives, 90)
const posP50 = percentile(all.positives, 50)
const negP99 = percentile(all.negatives, 99)
const negMax = all.negatives[all.negatives.length - 1] ?? 0

console.log(`\n全局（三库合并）`)
console.log(`  正例 n=${all.positives.length}：p50=${posP50} p90=${posP90} p95=${percentile(all.positives, 95)} max=${all.positives[all.positives.length - 1] ?? 0}`)
console.log(`  负例 n=${all.negatives.length}：p50=${percentile(all.negatives, 50)} p90=${percentile(all.negatives, 90)} p99=${negP99} max=${negMax}`)

// 建议阈值：正例高分位与负例极端值的折中
const suggestedHighRisk = Math.max(Math.round(Math.max(posP90, negP99) * 100) / 100, 0.01)
console.log(`\n建议 keyword_only 阈值：`)
console.log(`  high_risk_similarity ≈ ${suggestedHighRisk}（正例 p90=${posP90} 与负例 p99=${negP99} 的上界取整）`)
console.log(`  边界带 ≈ [${Math.round(Math.max(posP50, negP99) * 100) / 100}, ${suggestedHighRisk}）—— 即"像但不完全像"的区间`)
console.log(`\n对照：pack 里给 vector 模式的 high_risk_similarity=0.85（余弦口径，不可直接套用到 keyword 模式）`)

db.close()
