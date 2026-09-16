/**
 * Phase 1 · S-asta spike —— Asta MCP 作为 dsh 工具行的 L1 实证。
 *
 * ## 这个测试证明什么
 *
 * `@deepseek-ai/dsh-mcp-client` 能把外部 MCP server 的工具注册进**真实的**
 * `ToolRuntime`，并给出稳定的 server 限定名 `mcp__<serverName>__<rawName>`。
 * 这对本项目的意义不是"多了一个检索工具"，而是：工具名进入 `toolFilter`
 * 与权限规则，因此必须先在真实运行时里把名字钉死（S1 已实证：`restrict()`
 * 遇到未知工具名会直接抛错）。
 *
 * 断言：
 *   1. mcp-client 的行配置形态（streamable-http + headers）被接受；
 *   2. Asta 的 8 个工具全部出现在工具目录里；
 *   3. 名字恰好是 `mcp__asta__<rawName>`，与 SKILL.md 的意图路由表逐一对应；
 *   4. 注册的工具能被**真实执行**并返回论文数据（不是只列出 schema）。
 *
 * ## 前置（缺一不可）
 *
 * - `ASTA_API_KEY` 环境变量；
 * - `HTTPS_PROXY` 指向本地代理，**且** `NODE_USE_ENV_PROXY=1`。
 *   实测（2026-09-16）：只设 `HTTPS_PROXY` 时 Node 24 的 global fetch
 *   **忽略它**并返回 403；补上 `NODE_USE_ENV_PROXY=1` 才 200。
 *   MCP client 的 streamable-http 走的正是 global fetch，所以宿主进程
 *   必须带这两个变量启动。
 *
 * ## 为什么不需要重启宿主
 *
 * 它测的是"行能否装载 + 工具能否注册"，不是端到端委派。宿主装载仍需
 * 重启后验证（勘误 §5.4 的隔离 DSH_HOME 方法）。
 *
 * 运行：
 *   $env:ASTA_API_KEY='...'; $env:HTTPS_PROXY='http://127.0.0.1:10808'; $env:NODE_USE_ENV_PROXY='1'
 *   node tests/spike-asta-mcp.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

// 契约的权威来源是**构建产物**：运行时加载的是 lib/，不是 src/。
import { ASTA_TOOL_NAMES } from '../packages/dsh-plugin/lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
const ASTA_URL = 'https://asta-tools.allen.ai/mcp/v1'

/**
 * 期望集直接取自契约。这正是本 spike 不可替代的地方：它把 `ASTA_TOOL_NAMES`
 * 与**远端服务器实际注册的工具**逐一对齐，而离线测试 `names.test.mjs` 只能
 * 校验契约自洽（它不能依赖网络、代理与 API key）。
 */
const EXPECTED_PUBLIC_NAMES = Object.values(ASTA_TOOL_NAMES).sort()

function loadPackage(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

/** 与 S1 spike 相同：动态 import 得到的是命名空间对象，cordis 不接受。 */
function asPlugin(module) {
  if (typeof module.apply === 'function') {
    return {
      ...(typeof module.name === 'string' ? { name: module.name } : {}),
      ...(module.inject === undefined ? {} : { inject: module.inject }),
      apply: module.apply,
    }
  }
  if (typeof module.default === 'function' || typeof module.default?.apply === 'function') {
    return module.default
  }
  throw new Error(`asPlugin: 无法识别的插件形态，导出为 ${Object.keys(module).join(', ')}`)
}

const apiKey = process.env.ASTA_API_KEY
assert.ok(apiKey, 'ASTA_API_KEY 未设置')

const tools = await loadPackage('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadPackage('@deepseek-ai/dsh-system-prompt')
const cordis = await loadPackage('@deepseek-ai/cordis')
const mcpClient = await loadPackage('@deepseek-ai/dsh-mcp-client')

const Context = cordis.Context
const app = new Context()

let runtime
await app.plugin({
  name: 'spike-host',
  async apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    await ctx.plugin({
      name: 'spike-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) {
        runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
      },
    })
  },
})

assert.ok(runtime !== undefined, 'ToolRuntime 未成功挂载')
console.log('✅ 前置: 真实 ToolRuntime 已挂载')

// ── S-asta-a：装载 mcp-client 行 ─────────────────────────────────────────────
// failOnStartupError 显式设为 true：默认 false 会在连接失败时静默地"没有工具"，
// 那正是本项目最讨厌的"看起来绿、实际有问题"。
const astaRow = await app.plugin(
  { ...asPlugin(mcpClient), Config: mcpClient.Config },
  {
    serverName: 'asta',
    transport: 'streamable-http',
    url: ASTA_URL,
    headers: { 'x-api-key': apiKey },
    failOnStartupError: true,
  },
)
console.log('✅ S-asta-a: mcp-client 行装载成功（streamable-http + x-api-key）')

// ── S-asta-b/c：工具目录与命名 ──────────────────────────────────────────────
const names = runtime.schemas().map((s) => s.name).sort()
console.log('   工具目录:', names.join(', '))

const expectedPublic = EXPECTED_PUBLIC_NAMES
assert.deepEqual(names, expectedPublic, '远端注册的工具集与 ASTA_TOOL_NAMES 契约不一致')
console.log(`✅ S-asta-b: ${names.length} 个工具全部注册，且与 ASTA_TOOL_NAMES 契约逐一对齐`)

for (const n of names) {
  assert.match(n, /^mcp__asta__[a-z_]+$/, `工具名不符合 server 限定约定: ${n}`)
}
console.log('✅ S-asta-c: 命名稳定为 mcp__asta__<rawName>（可安全写入 toolFilter）')

// ── S-asta-d：真实执行一次，返回真实论文数据 ─────────────────────────────────
const call = await runtime.execute({
  callId: 'spike-asta-call',
  name: 'mcp__asta__search_paper_by_title',
  arguments: { title: 'Attention Is All You Need', fields: 'title,year,venue,externalIds' },
  signal: AbortSignal.timeout(60000),
})

const rendered = JSON.stringify(call)
console.log('   执行结果（前 300 字符）:', rendered.slice(0, 300))
assert.ok(!/isError"?\s*:\s*true/.test(rendered), '工具调用返回了 isError')
// 注意大小写：语料里的标题是 "Attention is All you Need"（小写 is / 小写 you），
// 因此按词匹配而不按原样字符串匹配。
assert.ok(
  /attention/i.test(rendered) && /all you need/i.test(rendered),
  '未返回预期论文，说明鉴权或数据通路有问题',
)
assert.ok(rendered.includes('1706.03762'), '未返回预期的 arXiv id，数据通路可疑')
console.log('✅ S-asta-d: 经 ToolRuntime 真实调用成功并返回论文数据')

// ── S-asta-e：卸载该行，验证工具被干净注销 ──────────────────────────────────
// 两件事：① 不清收尾会让 MCP 的保活连接拽住事件循环（本 spike 第一次跑就是这么挂住的）；
// ② 卸载是**异步**的 —— mcp-client 要先取消重连、关连接、等 in-flight 与队列中的
//    sync 静默，才注销当前代工具，因此必须轮询而不能立即断言。
// `ctx.plugin()` 返回的不是 disposer 函数，而是带 `.dispose()` 的 Fork 对象。
if (typeof astaRow?.dispose === 'function') {
  await astaRow.dispose()
} else {
  throw new Error(`无法卸载 mcp-client 行：plugin() 返回 ${typeof astaRow}，且没有 dispose()`)
}

let afterUnmount = runtime.schemas().map((s) => s.name)
for (let i = 0; i < 50 && afterUnmount.length > 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  afterUnmount = runtime.schemas().map((s) => s.name)
}
assert.equal(afterUnmount.length, 0, `卸载后工具未被注销，仍剩: ${afterUnmount.join(', ')}`)
console.log('✅ S-asta-e: 卸载行后工具被干净注销')

console.log('\nASTA MCP SPIKE OK')
process.exit(0)
