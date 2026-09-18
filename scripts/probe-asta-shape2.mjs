import { resolveDshModules, resolveDshPackage } from './lib/dsh-root.mjs'
/** 一次性探查：打印 get_paper_batch 调用的完整结果对象结构（含 structuredContent？）。 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1'
if (!process.env.NO_PROXY) process.env.NO_PROXY = 'localhost,127.0.0.1,::1,mineru.net,aliyuncs.com,openxlab.org.cn,api.deepseek.com'
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

const DSH = resolveDshModules()
const loadPackage = (spec) => {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const asPlugin = (module) => {
  if (typeof module.apply === 'function') {
    return { ...(typeof module.name === 'string' ? { name: module.name } : {}), ...(module.inject === undefined ? {} : { inject: module.inject }), apply: module.apply }
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
  name: 'probe5-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'probe5-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) { runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {}) },
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

const call = await runtime.execute({
  callId: 'probe5-a',
  name: 'mcp__asta__get_paper_batch',
  arguments: { ids: ['CorpusId:261276979', 'CorpusId:247793039', 'CorpusId:215416146'], fields: 'title,year,venue,externalIds' },
  signal: AbortSignal.timeout(60000),
})
console.log('call keys:', Object.keys(call ?? {}))
console.log('value keys:', Object.keys(call?.value ?? {}))
console.log('content length:', call?.value?.content?.length)
const text = call?.value?.content?.[0]?.text
console.log('text length:', String(text ?? '').length)
console.log('--- text 全文 ---')
console.log(String(text ?? ''))
console.log('--- structuredContent ---')
console.log(JSON.stringify(call?.value?.structuredContent ?? null).slice(0, 800))

const snippet = await runtime.execute({
  callId: 'probe5-b',
  name: 'mcp__asta__snippet_search',
  arguments: { query: 'audio deepfake detection', limit: 100 },
  signal: AbortSignal.timeout(120000),
})
const sText = snippet?.value?.content?.[0]?.text
let parsed
try { parsed = JSON.parse(String(sText)) } catch {}
console.log('\n=== snippet_search limit=100')
console.log('text length:', String(sText ?? '').length)
console.log('data length:', Array.isArray(parsed?.data) ? parsed.data.length : '(not array)')
console.log('distinct corpusIds:', Array.isArray(parsed?.data) ? new Set(parsed.data.map((d) => d?.paper?.corpusId)).size : 0)
await astaRow.dispose()
process.exit(0)
