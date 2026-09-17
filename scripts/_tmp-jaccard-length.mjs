// 临时：同一段条目原文被"更长的 idea"包含时，相似度如何变化（Jaccard 的并集归一化效应）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const require = createRequire(DSH + 'package.json')
const core = await import(pathToFileURL('packages/core/lib/index.js').href)
const { KbService } = await import(pathToFileURL('packages/dsh-plugin/lib/kb/service.js').href)
const systemPrompt = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')).href)
const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

const app = new cordis.Context()
await app.plugin({ name: 'outer', async apply(ctx) { await ctx.plugin(systemPrompt.default) } })
let kb
await app.plugin({ name: 'core', inject: ['systemPrompt'], apply(ctx) { kb = new KbService(ctx, { dbPath: 'data/papers/metadata.db' }) } })

const statement = kb.searchEntries({ store: 'methods', limit: 1 })[0].statement
const para = '本文面向持续学习场景下的深度伪造检测，设计了一套两阶段的增量适配方案：'
  + '第一阶段冻结预训练视觉主干的底层，仅更新归一化层与轻量适配器以保留通用伪造痕迹表征；'
  + '第二阶段引入频域一致性约束，约束新旧任务在频谱响应上的一致性，抑制对旧伪造类型的遗忘；'
  + '训练过程中维护一个按分布密度挑选的稀疏回放缓冲，用回放蒸馏把旧任务的决策边界带入新任务；'
  + '评测时在跨数据集与跨生成器设定下同时报告泛化性能与遗忘程度，并给出消融实验说明各模块贡献。'

console.log('条目 M001 原文长度：', statement.length, '字\n')
for (const target of [300, 500, 700, 900]) {
  let text = statement
  while (text.length < target) text = text.includes(statement) && text.length > statement.length ? text : `${para}${statement}${text.slice(statement.length)}${para}`
  // 保证条目原文完整包含在 idea 里，用 padding 把长度撑到目标
  let idea = statement
  let round = 0
  while (idea.length < target && round < 20) { idea = `${idea}${para}`; round += 1 }
  const sim = core.lexicalSimilarity(idea, statement)
  const novelty = Math.round(100 * (1 - sim))
  const verdict = sim >= 0.30 ? '判撞车（≥0.30 近似同文）' : (sim >= 0.10 ? '落边界带 → 触发外扩检索' : '判为不相关')
  console.log(`idea ${String(idea.length).padStart(4)} 字（条目原文完整包含在内）：相似度=${sim.toFixed(4)}  novelty=${String(novelty).padStart(3)}  → ${verdict}`)
}
kb.close()
