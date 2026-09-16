/**
 * P2-5b · Asta 元数据富化。
 *
 * 对论文库中缺外部 ID 的记录（Zotero 导入的 local 条目），用 Asta 的
 * `search_paper_by_title` 找回 DOI / arXiv / 引用数 / 摘要 / 作者，合并回
 * metadata.db。合并走 §7.5.2 规则；source_channel 保留原记录的值（富化不
 * 改变来源通道语义）。
 *
 * 前置（与 scripts/start-dsh-web.ps1 一致，本脚本自行补默认值）：
 *   - ASTA_API_KEY（.env.local 或环境）
 *   - HTTPS_PROXY + NODE_USE_ENV_PROXY=1（Asta 域名在本网络必须走代理）
 *
 * 用法：
 *   node scripts/enrich-asta.mjs            # 默认每批 20 条
 *   $env:ASTA_ENRICH_LIMIT='50'; node scripts/enrich-asta.mjs
 *
 * 安全设计：
 *   - 标题归一化**完全相等**才接受匹配，宁可跳过也不写错（错配的元数据比缺失更糟）；
 *   - 每次调用间隔 1s（Asta 无公开速率文档，保守为要）；
 *   - 逐条落库（合并幂等），中断后重跑不产生脏数据。
 *
 * L1 实测的坑（2026-09-16，debug-asta-shape 脚本）：
 *   - `fields` 里带 `abstract`（或扩字段组合）会让 Asta 服务端**挂起**，MCP 层
 *     报 -32001 TimeoutError；只用 'title,year,venue,externalIds' 正常。
 *     因此本脚本只用该组合；引用数/摘要留到 get_paper（P2-6 前的独立批）。
 *   - 返回形状：`call.value` 是 `{ content: [{type:'text', text:'<JSON 字符串>'}] }`，
 *     真正的记录在 text 里，需先 JSON.parse。
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { normalizeTitle } from '../packages/core/lib/index.js'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'

// ── 环境（与 start-dsh-web.ps1 同约定：已存在的不覆盖）────────────────────
if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = 'http://127.0.0.1:10808'
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1'
if (!process.env.NO_PROXY) process.env.NO_PROXY = 'localhost,127.0.0.1,::1,mineru.net,api.deepseek.com'

try {
  const dotEnv = await readFile('.env.local', 'utf8')
  for (const rawLine of dotEnv.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '' && !process.env[key]) process.env[key] = value
  }
} catch {
  // .env.local 缺失时靠环境变量
}

if (!process.env.ASTA_API_KEY) {
  console.error('ASTA_API_KEY 未配置：检索工具会静默消失。请写入 .env.local 或环境变量。')
  process.exit(2)
}

const LIMIT = Number(process.env.ASTA_ENRICH_LIMIT ?? 20)

// ── 挂载 Asta MCP（与 tests/spike-asta-mcp.mjs 同款）───────────────────────
const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const loadPackage = (spec) => {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const asPlugin = (module) => {
  if (typeof module.apply === 'function') {
    return {
      ...(typeof module.name === 'string' ? { name: module.name } : {}),
      ...(module.inject === undefined ? {} : { inject: module.inject }),
      apply: module.apply,
    }
  }
  if (typeof module.default === 'function' || typeof module.default?.apply === 'function') return module.default
  throw new Error('无法识别的插件形态')
}

const tools = await loadPackage('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadPackage('@deepseek-ai/dsh-system-prompt')
const cordis = await loadPackage('@deepseek-ai/cordis')
const mcpClient = await loadPackage('@deepseek-ai/dsh-mcp-client')

const app = new cordis.Context()
let runtime
await app.plugin({
  name: 'enrich-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'enrich-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) {
        runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
      },
    })
  },
})

const astaRow = await app.plugin(
  { ...asPlugin(mcpClient), Config: mcpClient.Config },
  {
    serverName: 'asta',
    transport: 'streamable-http',
    url: 'https://asta-tools.allen.ai/mcp/v1',
    headers: { 'x-api-key': process.env.ASTA_API_KEY },
    failOnStartupError: true,
  },
)
console.log(`Asta MCP 已挂载：${runtime.schemas().length} 个工具`)

// ── 候选集：缺外部 ID 的记录 ────────────────────────────────────────────────
const database = new PaperDatabase('data/papers/metadata.db')
const library = new PaperLibrary(database)
const candidates = database.raw
  .prepare("SELECT * FROM papers WHERE doi IS NULL AND arxiv_id IS NULL ORDER BY title LIMIT ?")
  .all(LIMIT)

console.log(`候选（缺 DOI 且缺 arXiv）: ${candidates.length} 条（上限 ${LIMIT}）\n`)

let seq = 0
const stats = { matched: 0, enriched: 0, titleMismatch: 0, failed: 0, skippedNoResult: 0 }
const now = new Date().toISOString()

for (const row of candidates) {
  const existing = library.get(row.paper_id)
  if (existing === undefined) continue
  seq += 1
  let call
  try {
    call = await runtime.execute({
      callId: `enrich-${seq}`,
      name: 'mcp__asta__search_paper_by_title',
      arguments: { title: existing.title, fields: 'title,year,venue,externalIds' },
      signal: AbortSignal.timeout(60000),
    })
  } catch (error) {
    stats.failed += 1
    console.log(`[${seq}/${candidates.length}] 调用失败 ${existing.title.slice(0, 60)}: ${error.message}`)
    await sleep(1000)
    continue
  }

  const found = extractBestMatch(call)
  if (found === undefined) {
    stats.skippedNoResult += 1
    await sleep(1000)
    continue
  }

  if (normalizeTitle(found.title ?? '') !== normalizeTitle(existing.title)) {
    stats.titleMismatch += 1
    console.log(`[${seq}/${candidates.length}] 标题不符，跳过：库「${existing.title.slice(0, 50)}」← 候选「${(found.title ?? '').slice(0, 50)}」`)
    await sleep(1000)
    continue
  }

  stats.matched += 1
  const externalIds = found.externalIds ?? {}
  const doi = externalIds.DOI ?? externalIds.doi
  const arxiv = externalIds.ArXiv ?? externalIds.arxiv
  const enriched = {
    ...existing,
    ...(doi === undefined ? {} : { doi: String(doi) }),
    ...(arxiv === undefined ? {} : { arxiv_id: String(arxiv) }),
    ...(found.year === undefined ? {} : { year: Number(found.year) }),
    ...(found.venue === undefined ? {} : { venue: String(found.venue) }),
    source_channel: existing.source_channel, // 富化不改变来源通道语义
    updated_at: now,
  }
  const outcome = library.upsert(enriched)
  if (outcome.merged) {
    stats.enriched += 1
    console.log(`[${seq}/${candidates.length}] ✓ ${existing.title.slice(0, 60)} → doi=${doi ?? '-'} arxiv=${arxiv ?? '-'} year=${found.year ?? '-'}`)
  } else {
    stats.failed += 1
    console.log(`[${seq}/${candidates.length}] ✗ 合并未生效（${outcome.matched_kind}） ${existing.title.slice(0, 60)}`)
  }
  await sleep(1000)
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
if (typeof astaRow?.dispose === 'function') await astaRow.dispose()
database.close()

console.log('\n── Asta 富化完成 ──────────────────────────────')
console.log(`候选 ${candidates.length}：匹配 ${stats.matched}、富化 ${stats.enriched}、标题不符 ${stats.titleMismatch}、无结果 ${stats.skippedNoResult}、失败 ${stats.failed}`)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从 ToolRuntime 结果里取出单篇匹配（L1 实测形状：value.content[0].text 是 JSON 字符串）。 */
function extractBestMatch(call) {
  if (call?.isError) return undefined
  const text = call?.value?.content?.[0]?.text ?? call?.content?.[0]?.text
  if (typeof text !== 'string') return undefined
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const record = Array.isArray(payload.data) && payload.data.length > 0 ? payload.data[0] : payload
  if (record === null || typeof record !== 'object' || record.title === undefined) return undefined
  return record
}
