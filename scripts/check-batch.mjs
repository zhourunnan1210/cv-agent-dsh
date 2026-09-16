/** 单次查询 batch 状态（不轮询）。用法：node scripts/check-batch.mjs <batch_id> */
import { readFile } from 'node:fs/promises'

const batchId = process.argv[2]
try {
  const dotEnv = await readFile('.env.local', 'utf8')
  for (const rawLine of dotEnv.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '' && !process.env[key]) process.env[key] = value
  }
} catch {
  // 靠环境
}
const response = await fetch(`https://mineru.net/api/v4/extract-results/batch/${batchId}`, {
  headers: { Authorization: `Bearer ${process.env.MINERU_TOKEN}` },
})
console.log('HTTP', response.status)
console.log((await response.text()).slice(0, 1200))
