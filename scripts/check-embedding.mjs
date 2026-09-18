/**
 * Embedding 语义相似度的关键验证（整合设计 v1.0 §9 第 4 步的前置）。
 *
 * 要回答一个问题：**换上 embedding，那个 0.000 的病治好了吗？**
 *
 * 对照基准（core 的字符 trigram，实测）：
 *   同义改写「跨生成器泛化」vs「跨数据集泛化」→ 0.000
 *   中英同义「跨生成器泛化」vs「cross-generator generalization」→ 0.000
 *   无关「量子纠缠…」→ 0.000
 * 也就是说字面度量**无法区分"换词"与"无关"**——两者都给 0。
 *
 * 模型走 hf-mirror（HF 直连超时）。用法：
 *   HF_ENDPOINT=https://hf-mirror.com node scripts/check-embedding.mjs [模型名]
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + 'package.json')
const core = await import(pathToFileURL('packages/core/lib/index.js').href)

const MODEL = process.argv[2] ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

const transformers = await import(
  pathToFileURL(require.resolve('@huggingface/transformers', { paths: [process.cwd()] })).href
).catch(() => import('@huggingface/transformers'))

const { pipeline, env } = transformers
// 模型缓存放仓库内，便于核对与离线复用
env.cacheDir = 'data/models'
await mkdir(env.cacheDir, { recursive: true })

console.log(`模型：${MODEL}`)
console.log(`缓存：${env.cacheDir}`)
console.log(`镜像：${process.env.HF_ENDPOINT ?? '(未设置 HF_ENDPOINT，将直连 HF)'}\n`)

const started = Date.now()
const extract = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' })
console.log(`模型加载完成：${((Date.now() - started) / 1000).toFixed(1)}s\n`)

/** 归一化后的向量（余弦 = 点积）。 */
async function embed(text) {
  const output = await extract(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
function cosine(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return dot
}

const pairs = [
  ['跨生成器泛化', '跨数据集泛化', '近义（共享「跨…泛化」）'],
  ['跨生成器泛化', 'cross-generator generalization', '中英同义'],
  ['未见生成器上的检测', 'unseen generator detection', '中英同义'],
  ['用对比学习提升泛化', 'contrastive learning for generalization', '中英同义'],
  ['小样本下该损失不收敛', '该损失在小样本条件下无法收敛', '同义改写'],
  ['基于频域一致性约束抑制灾难性遗忘', '用频率域的一致性正则减少增量学习中的遗忘', '同义改写（换词较多）'],
  ['跨生成器泛化', '量子纠缠在低温超导中的退相干机制研究', '无关（对照）'],
  ['跨生成器泛化', '跨生成器泛化', '完全相同（上界）'],
]

console.log('文本对'.padEnd(46), 'trigram', '  embedding', '  判读')
console.log('-'.repeat(96))
let embeddingFixed = 0
let lexicalZeroButEmbeddingHigh = 0
for (const [a, b, label] of pairs) {
  const lex = core.lexicalSimilarity(a, b)
  const [va, vb] = [await embed(a), await embed(b)]
  const cos = cosine(va, vb)
  const note = lex < 0.01 && cos > 0.5 ? '★ embedding 修好了' : ''
  if (note !== '') lexicalZeroButEmbeddingHigh += 1
  if (cos > 0.5 && label !== '无关（对照）' && label !== '完全相同（上界）') embeddingFixed += 1
  const shown = `${label}`.slice(0, 20).padEnd(22) + `${a.slice(0, 8)}|${b.slice(0, 8)}`
  console.log(shown.padEnd(46), lex.toFixed(3).padStart(6), cos.toFixed(3).padStart(10), ' ', note)
}

console.log('\n维度：', (await embed('测试')).length)
console.log(`字面为 0 但语义 > 0.5 的对：${lexicalZeroButEmbeddingHigh} 组`)
console.log(`语义 > 0.5 的正常对：${embeddingFixed} / 6`)
