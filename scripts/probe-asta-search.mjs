/** 一次性探查：打印 search_papers_by_relevance 一次调用的原始返回形状。 */
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

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
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
  name: 'probe2-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'probe2-tools',
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
  callId: 'probe2-call',
  name: 'mcp__asta__search_papers_by_relevance',
  arguments: { keyword: 'audio deepfake detection', fields: 'title,year,venue,externalIds', limit: 5 },
  signal: AbortSignal.timeout(60000),
})
console.log('isError:', call?.isError)
const text = call?.value?.content?.[0]?.text ?? call?.content?.[0]?.text
console.log('text type:', typeof text, 'length:', text?.length)
console.log('raw:', String(text).slice(0, 2000))
await astaRow.dispose()
process.exit(0)
