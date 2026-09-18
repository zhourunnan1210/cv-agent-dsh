/**
 * 文本相似度（**唯一剩下的用途：论文库浏览检索的排序**）。
 *
 * ## 这份文件原来有什么，以及为什么只剩这些
 *
 * 它曾经是"Idea 打分的确定性部分"：证据派生、检索基线分、边界带外扩判据、
 * 裁判判定应用、加权总分、档位映射、风险分级、报告复算——一整套**单裁判链路**。
 *
 * 2026-09-18 全部删除。原因两条，都是用户裁定的方向：
 *
 * 1. **打分改由三位专家推理给出**（`dsh-plugin/src/scoring/panel.ts`：模块级对齐 +
 *    四维分 + 分歧讨论 + 中位数聚合）。旧链路是"裁判只判撞不撞、分数由本层从字符
 *    相似度算出来"——同义改写的相似度只有 0.0039，于是真撞车会被算成满分新颖。
 * 2. **撞车召回改由子代理读全库**（`screen.ts`）。边界带那个 `[0.10, 0.30)` 判据
 *    的前提是"低相似度 = 无关"，而同义改写恰好也是低相似度——最该外扩的情况反而不触发。
 *
 * 所以这里剩下的 `lexicalSimilarity` **不再参与撞车判断，也不参与打分**。
 * 它现在的唯一调用方是 MCP 的 `kb_search` 浏览检索（`dsh-plugin/src/mcp/kb-adapter.ts`）——
 * 那里需要一个 [0,1] 的排序分，给**人／Agent 主动查库**用。
 *
 * @module cv-research/core/scoring-score
 */

/** 检索模式标记。 */
export type ScoreRetrievalMode = 'vector' | 'keyword_only'

/**
 * 字符级 trigram 集合（含 1/2-gram 短串兜底），用于 Jaccard 相似度。
 *
 * 为什么用字符而不用词：中文没有空格分词，字符 n-gram 对中英混排都稳定；
 * 归一化（小写、去非字母数字、压缩空白）与三库 statement 的去重归一化同源，
 * 保证「同一句话的两种写法」在这里也高度相似。
 */
export function trigramSet(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const grams = new Set<string>()
  if (normalized === '') return grams
  const compact = normalized.replace(/\s+/g, '')
  if (compact.length <= 3) {
    grams.add(compact)
    return grams
  }
  for (let i = 0; i <= compact.length - 3; i += 1) grams.add(compact.slice(i, i + 3))
  return grams
}

/**
 * 词项集合（按非字母数字切分），用于补一层"词级"信号。
 *
 * trigram 对**同义改写**（deepfake → face forgery）无能为力，这一层也不解决语义，
 * 但它能把「方法名相同但句式不同」这类情况拉高一点，减少假阴性。
 */
export function termSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1),
  )
}

/**
 * 确定性相似度 ∈ [0,1]：字符 trigram Jaccard 与词 Jaccard 的加权融合。
 *
 * ⚠️ **词层是自适应的，不能固定 0.6/0.4**：中文没有空格分词，按非字母数字切分
 * 会把整句变成一个 token（「跨数据集泛化与持续学习遗忘」→ 1 个 token），此时词层
 * Jaccard 恒为 0，会把语序不同但用词相同的两句从 0.57 压到 0.34（实测）。
 * 因此：某一侧词数 < 2 时自动**退化为纯 trigram**；两侧都有足够词项（英文/术语场景）
 * 才启用词层。
 */
export function lexicalSimilarity(a: string, b: string): number {
  if (a.trim() === '' || b.trim() === '') return 0
  const gramScore = jaccard(trigramSet(a), trigramSet(b))
  const termA = termSet(a)
  const termB = termSet(b)
  if (termA.size < 2 || termB.size < 2) return round4(gramScore)
  return round4(0.6 * gramScore + 0.4 * jaccard(termA, termB))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
