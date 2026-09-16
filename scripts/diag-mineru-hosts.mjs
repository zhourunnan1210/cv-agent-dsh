/**
 * 诊断：MinerU 的签名上传链接落在哪个 host，以及**不走代理**能否直连。
 * 用法：node scripts/diag-mineru-hosts.mjs
 */

import { readFile } from 'node:fs/promises'

// 显式清掉代理，模拟「代理挂掉」时的环境
delete process.env.HTTPS_PROXY
delete process.env.HTTP_PROXY
delete process.env.https_proxy
delete process.env.http_proxy

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
} catch {}

const token = process.env.MINERU_TOKEN
if (!token) {
  console.error('MINERU_TOKEN 未配置')
  process.exit(2)
}

// 1. API 端点（mineru.net）能否直连
const t0 = Date.now()
const response = await fetch('https://mineru.net/api/v4/file-urls/batch', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ files: [{ name: 'diag-probe.pdf', data_id: 'diag-probe' }] }),
})
const body = await response.json()
console.log(`API mineru.net：HTTP ${response.status}，${Date.now() - t0}ms，code=${body?.code}`)
const urls = body?.data?.file_urls ?? []
console.log(`batch_id：${body?.data?.batch_id}`)
for (const url of urls) {
  const parsed = new URL(url)
  console.log(`签名上传 host：${parsed.host}  路径前缀：${parsed.pathname.slice(0, 60)}`)

  // 2. 该 host 直连（无代理）能否完成一次小 PUT
  const payload = new TextEncoder().encode('%PDF-1.4\n% diag probe\n')
  const t1 = Date.now()
  try {
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Length': String(payload.byteLength) }, body: payload })
    console.log(`  PUT 直连（无代理）：HTTP ${put.status}，${Date.now() - t1}ms`)
  } catch (error) {
    console.log(`  PUT 直连（无代理）失败：${error.message} / cause=${error.cause?.code ?? '-'}`)
  }
}
