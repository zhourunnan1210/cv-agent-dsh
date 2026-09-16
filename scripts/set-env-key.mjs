/**
 * 只做一件事：确保 `.env.local` 里有某个 KEY=（缺则追加），**不回显任何已有密钥值**。
 * 用法：node scripts/set-env-key.mjs <KEY> <VALUE>
 */
import { readFile, writeFile } from 'node:fs/promises'

const [key, value] = process.argv.slice(2)
if (!key || value === undefined) {
  console.error('用法：node scripts/set-env-key.mjs <KEY> <VALUE>')
  process.exit(2)
}

let content = ''
try {
  content = await readFile('.env.local', 'utf8')
} catch {
  content = ''
}

const lines = content.split(/\r?\n/)
const existing = lines.findIndex((line) => line.trim().startsWith(`${key}=`))
if (existing >= 0) {
  const current = lines[existing].slice(lines[existing].indexOf('=') + 1).trim()
  if (current === value) {
    console.log(`${key} 已存在且值相同（未改动）`)
    process.exit(0)
  }
  lines[existing] = `${key}=${value}`
  await writeFile('.env.local', lines.join('\n'), 'utf8')
  console.log(`${key} 已更新（旧值长度 ${current.length} → 新值长度 ${value.length}）`)
  process.exit(0)
}

const next = `${content.replace(/\s*$/, '')}\n${key}=${value}\n`
await writeFile('.env.local', next, 'utf8')
console.log(`${key} 已追加到 .env.local（现共 ${next.split(/\r?\n/).filter((l) => l.includes('=')).length} 项配置）`)
console.log('已有配置项（仅键名）：')
for (const line of next.split(/\r?\n/)) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) console.log(`  - ${line.slice(0, i).trim()}`)
}
