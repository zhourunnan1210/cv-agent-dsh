/**
 * 预设组合静态预检 CLI。
 *
 * 用法：node scripts/check-preset.mjs [preset 文件路径]
 *
 * 检查逻辑在 `scripts/lib/preset-check.mjs`（同一份逻辑被 `pnpm test` 里的
 * `preset-static.test.ts` 复用——2026-09-17 的挂载事故之后加的双保险）。
 */

import { resolve } from 'node:path'

import { checkPreset } from './lib/preset-check.mjs'

const presetPath = resolve(process.argv[2] ?? 'packages/dsh-plugin/presets/cv-research/agent.cordis.yml')
const result = await checkPreset(presetPath)

console.log(`预设：${presetPath}`)
console.log(`  行数：${result.rowCount}；唯一 id：${result.uniqueIds}`)
console.log(`  服务行：${result.serviceRows.map((row) => `${row.serviceName}(${row.id})`).join('、') || '(无)'}`)
console.log('  校验项：行名可解析 / id 唯一 / 服务行落在声明了该服务的 isolate group 内 / isolate 与行互相呼应')

if (result.notes.length > 0) {
  console.log(`\n提示 ${result.notes.length} 条：`)
  for (const note of result.notes) console.log(`  ⚠ ${note}`)
}
if (result.problems.length > 0) {
  console.error(`\n✗ 发现问题 ${result.problems.length} 条：`)
  for (const problem of result.problems) console.error(`  - ${problem}`)
  console.error('\n（这些都会导致宿主重启时 preset 挂载失败，而报错只在宿主日志里）')
  process.exit(1)
}
console.log('\nPRESET STATIC CHECK OK —— 结构可挂载（运行期行为仍需宿主重启验证）')
