import { resolveDshModules, resolveDshPackage } from './lib/dsh-root.mjs'
/**
 * 一次性探查：get_paper_batch 能否返回 openAccessPdf / isOpenAccess（全文获取的路由依据）。
 * 注意：字段组合不被接受时 Asta 服务端**可能挂起**（P2-5 的 abstract 教训），故设 60s 超时并只取 3 个 ID。
 */
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
  name: 'oa-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'oa-tools',
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

// 取库里 3 篇 asta 论文的 CorpusId（从 paper_id 的 ss: 前缀或 externalIds 无法直接拿，
// 这里改用已知的 3 个标题搜索得到的 S2 id）
const ids = ['CorpusId:261276979', 'CorpusId:247793039', 'CorpusId:215416146']
for (const fields of ['title,year,externalIds,openAccessPdf,isOpenAccess', 'title,isOpenAccess']) {
  console.log(`\n=== fields=${fields}`)
  try {
    const call = await runtime.execute({
      callId: `oa-${fields.length}`,
      name: 'mcp__asta__get_paper_batch',
      arguments: { ids, fields },
      signal: AbortSignal.timeout(60000),
    })
    const structured = call?.value?.structuredContent?.result
    const text = call?.value?.content?.[0]?.text
    console.log('isError:', call?.isError)
    console.log('structured 条数:', Array.isArray(structured) ? structured.length : '(非数组)')
    console.log('sample:', JSON.stringify(Array.isArray(structured) ? structured[0] : String(text).slice(0, 400)).slice(0, 700))
  } catch (error) {
    console.log('调用异常：', error.message)
  }
}
await astaRow.dispose()
process.exit(0)
