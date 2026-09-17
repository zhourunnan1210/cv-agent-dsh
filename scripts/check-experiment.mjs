/**
 * 实验归档齐备性校验（只读，不修改任何文件）。
 *
 * 依据：docs/实验归档与组织原则.md §5。「原则没有校验就只是愿望」——
 * 本脚本把三条硬规则变成可执行的 FAIL 清单。
 *
 * 用法：
 *   node scripts/check-experiment.mjs experiments/E001-short-slug
 *   node scripts/check-experiment.mjs --all
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const all = args.includes('--all')
const target = args.find((arg) => !arg.startsWith('--'))
const ROOT = resolve('experiments')

const results = []

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function checkExperiment(dir) {
  const name = dir.split(/[\\/]/).pop()
  const problems = []
  const notes = []

  // 1. README.md 的必备小节
  const readmePath = join(dir, 'README.md')
  if (!(await exists(readmePath))) {
    problems.push('缺 README.md')
  } else {
    const readme = await readFile(readmePath, 'utf8')
    for (const section of ['## 假设', '## 成功判据']) {
      if (!readme.includes(section)) problems.push(`README.md 缺小节 ${section}`)
    }
  }

  // 2. runs/<id>/ 的三件套
  const runsDir = join(dir, 'runs')
  let runIds = []
  if (!(await exists(runsDir))) {
    problems.push('缺 runs/ 目录')
  } else {
    runIds = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    if (runIds.length === 0) problems.push('runs/ 下没有任何运行目录')
    for (const runId of runIds) {
      for (const required of ['cmd.txt', 'env.txt', 'metrics.json']) {
        if (!(await exists(join(runsDir, runId, required)))) {
          problems.push(`runs/${runId} 缺 ${required}`)
        }
      }
      const metricsPath = join(runsDir, runId, 'metrics.json')
      if (await exists(metricsPath)) {
        try {
          const parsed = JSON.parse(await readFile(metricsPath, 'utf8'))
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            problems.push(`runs/${runId}/metrics.json 不是对象（机器可读指标应形如 {"auc": 0.93}）`)
          }
        } catch (error) {
          problems.push(`runs/${runId}/metrics.json 不是合法 JSON：${error.message}`)
        }
      }
    }
  }

  // 3. RESULTS.md（含负面结论要求）
  const resultsPath = join(dir, 'RESULTS.md')
  if (!(await exists(resultsPath))) {
    problems.push('缺 RESULTS.md')
  } else {
    const text = await readFile(resultsPath, 'utf8')
    const hasBelowTarget = /未达|不升|下降|negative|failed|负/i.test(text)
    const hasNegativeSection = text.includes('## 负面结论')
    if (hasBelowTarget && !hasNegativeSection) {
      notes.push('RESULTS.md 出现负面表述但没有 `## 负面结论` 小节（归档原则 §3 规则 2）')
    }
  }

  // 4. EVIDENCE.md 的每一行数字都要能溯源
  const evidencePath = join(dir, 'EVIDENCE.md')
  if (!(await exists(evidencePath))) {
    problems.push('缺 EVIDENCE.md')
  } else {
    const lines = (await readFile(evidencePath, 'utf8')).split(/\r?\n/)
    const dataRows = lines.filter((line) => line.trim().startsWith('|') && !/^\|[\s|:-]+\|$/.test(line.trim()))
    const headerRows = dataRows.filter((line) => /数字|含义|来源/.test(line))
    const body = dataRows.filter((line) => !headerRows.includes(line))
    if (body.length === 0) {
      notes.push('EVIDENCE.md 里没有任何数字行')
    }
    for (const line of body) {
      if (!/runs\/|paper:/.test(line)) {
        problems.push(`EVIDENCE.md 有一行无法溯源（既无 runs/ 路径也无 paper: 前缀）：${line.trim().slice(0, 80)}`)
      }
    }
  }

  // 5. INDEX.md 登记
  const indexPath = join(ROOT, 'INDEX.md')
  if (!(await exists(indexPath))) {
    notes.push('experiments/INDEX.md 不存在（总表缺失）')
  } else if (!(await readFile(indexPath, 'utf8')).includes(name)) {
    problems.push(`INDEX.md 里没有登记 ${name}`)
  }

  return { name, problems, notes, runCount: runIds.length }
}

if (all) {
  if (!(await exists(ROOT))) {
    console.error(`没有 experiments/ 目录（${ROOT}）`)
    process.exit(2)
  }
  const entries = await readdir(ROOT, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue
    results.push(await checkExperiment(join(ROOT, entry.name)))
  }
  if (results.length === 0) console.log('experiments/ 下没有实验（只有 _template 或为空）')
} else if (target !== undefined) {
  if (!(await exists(target))) {
    console.error(`目录不存在：${target}`)
    process.exit(2)
  }
  results.push(await checkExperiment(target))
} else {
  console.error('用法：node scripts/check-experiment.mjs <experiments/E00x-slug> | --all')
  process.exit(2)
}

let failed = 0
for (const result of results) {
  const ok = result.problems.length === 0
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${result.name}（runs: ${result.runCount}）`)
  for (const problem of result.problems) console.log(`   ✗ ${problem}`)
  for (const note of result.notes) console.log(`   ⚠ ${note}`)
}
console.log(`\n${failed === 0 ? 'ARCHIVE OK' : `ARCHIVE FAIL —— ${failed}/${results.length} 个实验不齐备`}`)
process.exit(failed === 0 ? 0 : 1)
