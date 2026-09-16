/**
 * P2-7 · Asta 从零检索控制组：验证「检索 → 入库 → 去重合并」通道端到端可用。
 *
 * 选一个语料几乎不覆盖的 Deepfake 子主题（audio deepfake detection，
 * 语音深度伪造检测；现有 147 条语料只有 3 条 audio-visual），从 Asta
 * 检索开始，把结果经与正式入库完全相同的路径
 * （normalizePaperId / dedupeMatch / PaperLibrary.upsert，§7.5.2 规则）
 * 写进 metadata.db，source_channel='asta'、pdf_status='pending'。
 *
 * 通道形态（L1 实测，2026-09-17）：
 *   - `search_papers_by_relevance` 的 `limit` **不生效**：无论 limit 传几都只回
 *     单篇最佳匹配 → 不能当批量检索用；
 *   - `snippet_search`（limit 100）才是有量的通道：100 条 snippet 覆盖 68 篇
 *     不同论文（`data[].paper` 只有 corpusId/title/authors）；
 *   - `get_paper_batch`（ids 数组 + fields）按 CorpusId 批量补 DOI/arXiv/year/venue；
 *   - **渲染陷阱**：`content[0].text` 只渲染第一条记录，完整数组在
 *     `value.structuredContent.result` 里。只读 text 会把 100 条误当 1 条。
 *
 * 用法：node scripts/asta-control.mjs [keyword1 keyword2 ...]
 *   缺省关键字：音频深伪相关的 4 组查询
 */

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { normalizePaperId, normalizeTitle } from '../packages/core/lib/index.js'
import { PaperDatabase } from '../packages/dsh-plugin/lib/kb/db.js'
import { PaperLibrary } from '../packages/dsh-plugin/lib/kb/library.js'

// ── 环境（与 enrich-asta.mjs 同约定）───────────────────────────────────────
if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
if (!process.env.HTTP_PROXY) process.env.HTTP_PROXY = 'http://127.0.0.1:10808'
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1'
if (!process.env.NO_PROXY) process.env.NO_PROXY = 'localhost,127.0.0.1,::1,mineru.net,aliyuncs.com,openxlab.org.cn,api.deepseek.com'

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
} catch {}

if (!process.env.ASTA_API_KEY) {
  console.error('ASTA_API_KEY 未配置。')
  process.exit(2)
}

const KEYWORDS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      'audio deepfake detection',
      'deepfake voice detection',
      'spoofed speech detection',
      'audio anti-spoofing countermeasure',
    ]
const SNIPPET_LIMIT = Number(process.env.ASTA_SNIPPET_LIMIT ?? 100)
const ENRICH_CHUNK = 50

// ── 挂载 Asta MCP ──────────────────────────────────────────────────────────
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
  name: 'control-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'control-tools',
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

const database = new PaperDatabase('data/papers/metadata.db')
const library = new PaperLibrary(database)
const now = new Date().toISOString()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 取完整记录数组：优先 structuredContent.result（text 只渲染第一条，是陷阱）。
 * 兼容三种形状：result 为数组、result.data 为数组、text 里是数组或单对象。
 */
function extractRecords(call) {
  if (call?.isError) return { error: String(call?.value?.content?.[0]?.text ?? call?.error ?? 'unknown') }
  const structured = call?.value?.structuredContent?.result
  if (Array.isArray(structured)) return { records: structured }
  if (Array.isArray(structured?.data)) return { records: structured.data }
  const text = call?.value?.content?.[0]?.text
  if (typeof text !== 'string') return { records: [] }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { records: [] }
  }
  if (Array.isArray(payload)) return { records: payload }
  if (Array.isArray(payload?.data)) return { records: payload.data }
  if (typeof payload?.title === 'string') return { records: [payload] }
  return { records: [] }
}

// ── 阶段 1：snippet_search 发现论文（按 corpusId 去重）─────────────────────
const discovered = new Map() // corpusId -> { title, authors }
let seq = 0
for (const keyword of KEYWORDS) {
  seq += 1
  const call = await runtime.execute({
    callId: `control-search-${seq}`,
    name: 'mcp__asta__snippet_search',
    arguments: { query: keyword, limit: SNIPPET_LIMIT },
    signal: AbortSignal.timeout(120000),
  })
  const { records, error } = extractRecords(call)
  if (error !== undefined) {
    console.warn(`[检索 ${seq}] ✗ ${keyword}：${error.slice(0, 160)}`)
    await sleep(1000)
    continue
  }
  let added = 0
  for (const record of records) {
    const paper = record?.paper ?? record
    const corpusId = paper?.corpusId
    if (corpusId === undefined || corpusId === null) continue
    const key = String(corpusId)
    if (discovered.has(key)) continue
    discovered.set(key, {
      title: String(paper.title ?? ''),
      authors: Array.isArray(paper.authors) ? paper.authors.map(String) : [],
    })
    added += 1
  }
  console.log(`[检索 ${seq}] ${keyword}：snippet ${records.length} 条 → 新增论文 ${added}，累计 ${discovered.size}`)
  await sleep(1000)
}

// ── 阶段 2：get_paper_batch 补元数据（DOI/arXiv/year/venue）───────────────
const ids = [...discovered.keys()]
const enriched = new Map() // corpusId(string) -> record
for (let start = 0; start < ids.length; start += ENRICH_CHUNK) {
  const chunk = ids.slice(start, start + ENRICH_CHUNK)
  seq += 1
  const call = await runtime.execute({
    callId: `control-enrich-${seq}`,
    name: 'mcp__asta__get_paper_batch',
    arguments: { ids: chunk.map((id) => `CorpusId:${id}`), fields: 'title,year,venue,externalIds' },
    signal: AbortSignal.timeout(120000),
  })
  const { records, error } = extractRecords(call)
  if (error !== undefined) {
    console.warn(`[富化 ${start / ENRICH_CHUNK + 1}] ✗ ${error.slice(0, 160)}`)
    await sleep(1000)
    continue
  }
  for (const record of records) {
    const corpusId = record?.externalIds?.CorpusId
    if (corpusId !== undefined && corpusId !== null) enriched.set(String(corpusId), record)
  }
  console.log(`[富化 ${start / ENRICH_CHUNK + 1}] 请求 ${chunk.length} 个 ID → 返回 ${records.length} 条，累计 ${enriched.size}`)
  await sleep(1000)
}

// ── 阶段 3：入库（与正式管线相同的 §7.5.2 去重/合并路径）──────────────────
const stats = {
  discovered: discovered.size,
  enriched: enriched.size,
  inserted: 0,
  mergedExisting: 0,
  needsReview: 0,
  skippedNoId: 0,
  failed: 0,
  externalIdCoverage: 0,
}
for (const [corpusId, fallback] of discovered) {
  const record = enriched.get(corpusId) ?? fallback
  const title = String(record.title ?? '').trim()
  if (title === '') {
    stats.skippedNoId += 1
    continue
  }
  const externalIds = record.externalIds ?? {}
  const doiRaw = externalIds.DOI ?? externalIds.doi
  const arxivRaw = externalIds.ArXiv ?? externalIds.arxiv
  const doi = doiRaw === undefined ? undefined : normalizePaperId(String(doiRaw))
  const arxivId = arxivRaw === undefined ? undefined : normalizePaperId(String(arxivRaw))
  const paperId = doi ?? arxivId ?? `ss:${corpusId}`
  if (doi === undefined && arxivId === undefined) stats.skippedNoId += 1
  else stats.externalIdCoverage += 1
  const candidate = {
    paper_id: paperId,
    title,
    authors: Array.isArray(record.authors) ? record.authors.map(String) : fallback.authors,
    ...(typeof record.year === 'number' ? { year: record.year } : {}),
    ...(typeof record.venue === 'string' ? { venue: record.venue } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(arxivId !== undefined ? { arxiv_id: arxivId } : {}),
    ...(typeof record.paperId === 'string' ? { url: `https://www.semanticscholar.org/paper/${record.paperId}` } : {}),
    source_channel: 'asta',
    pdf_status: 'pending',
    created_at: now,
    updated_at: now,
  }
  try {
    const outcome = library.upsert(candidate)
    // UpsertPaperOutcome：inserted / merged 是权威布尔位，matched_kind 为 null 才是新插入；
    // 标题命中按冻结纪律只报复核线索（needs_review），不写库
    if (outcome.inserted) stats.inserted += 1
    else if (outcome.merged) stats.mergedExisting += 1
    else if (outcome.needs_review) stats.needsReview += 1
  } catch (error) {
    stats.failed += 1
    console.warn(`  ✗ 入库失败（${paperId}）：${error.message}`)
  }
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
if (typeof astaRow?.dispose === 'function') await astaRow.dispose()
const summary = {
  executed_at: now,
  keywords: KEYWORDS,
  snippetLimit: SNIPPET_LIMIT,
  ...stats,
  libraryTotal: library.count(),
  astaChannelCount: database.raw.prepare("SELECT COUNT(*) c FROM papers WHERE source_channel = 'asta'").get().c,
}
await writeFile('data/papers/asta-control-summary.json', `${JSON.stringify(summary, null, 2)}\n`)
database.close()

console.log('\n── Asta 控制组完成 ────────────────────────────')
console.log(`关键词 ${KEYWORDS.length} 组：发现 ${stats.discovered} 篇，富化 ${stats.enriched} 篇`)
console.log(`新入库 ${stats.inserted}，合并入既有 ${stats.mergedExisting}，待复核 ${stats.needsReview}，失败 ${stats.failed}，无外部 ID ${stats.skippedNoId}`)
console.log(`外部 ID 覆盖：${stats.externalIdCoverage}/${stats.discovered}；论文库总量：${summary.libraryTotal}；asta 通道：${summary.astaChannelCount}`)
