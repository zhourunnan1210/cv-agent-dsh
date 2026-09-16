/**
 * 载入前的一次性对齐：把库里 P001 的 statement 改成 Analyst 版本的
 * 「实时与轻量化部署」，使随后 `load-entries.mjs` 的该条目**归一化相等而合并**
 * （source_papers 取并集），而不是新建一条语义重复的 problem。
 *
 * 背景：P001 原文案「实时（低延迟）deepfake 检测：在受限计算预算下同时保持高检测精度
 * 与跨数据集泛化」把「跨数据集泛化」也卷进来了，而本批 Analyst 已把跨数据集泛化单列为
 * 独立 problem。改后两条各有清晰边界。
 */

import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'

const NEW_STATEMENT = '实时与轻量化部署 (real-time / lightweight deployment)：高精度检测器计算开销大（百 GFLOPs 级、参数量大），难以在资源受限与低延迟场景落地'

const db = new PaperDatabase('data/papers/metadata.db')
const row = db.raw.prepare("SELECT entry_id, statement, source_papers FROM problems WHERE entry_id = 'P001'").get()
if (row === undefined) {
  console.log('P001 不存在，无需对齐')
} else {
  console.log(`旧：${row.statement}`)
  db.raw
    .prepare('UPDATE problems SET statement = ?, updated_at = ? WHERE entry_id = ?')
    .run(NEW_STATEMENT, new Date().toISOString(), 'P001')
  console.log(`新：${NEW_STATEMENT}`)
  console.log(`P001 source_papers（保持不变，随后由装载合并并集）：${row.source_papers}`)
}
db.close()
