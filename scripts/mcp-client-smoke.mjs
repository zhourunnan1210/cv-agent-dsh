/**
 * S5 验收：**以 MCP 客户端的身份**调用我们自己的 MCP 服务端（真实 stdio、真实库）。
 *
 * 勘误 §5.5 对 Spike S5 的验收原话是「把 kb.search + idea.score 两个接口包成 MCP，
 * 从 dsh 和另一个 MCP 客户端各调用一次」。dsh 那一侧就是会话里的
 * `cvagent_kb_search` / `cvagent_idea_score`；**另一个 MCP 客户端**就是本脚本：
 * 起一个子进程、按 MCP 规范握手、列工具、真调一次。
 *
 * 之所以要单列一条脚本而不是只写单测：单测证明"协议函数是对的"，
 * 这条证明"**进程真的能作为 MCP 服务端被用起来**"——包含 stdout 不被日志污染、
 * 子进程退出、真实 sqlite 读数这些只有真起进程才暴露的东西。
 *
 * 用法：node scripts/mcp-client-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const repoRoot = resolve(import.meta.dirname, '..')
const serverPath = resolve(repoRoot, 'scripts/mcp-serve.mjs')

const child = spawn(process.execPath, [serverPath], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderrLines = []
createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => stderrLines.push(line))

const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
const pending = new Map()
let nextId = 0

lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    // stdout 上出现非 JSON = 协议流被污染，这是最该报出来的失败
    fail(`stdout 出现了非 JSON 内容（协议流被污染）：${text.slice(0, 200)}`)
    return
  }
  const resolver = pending.get(message.id)
  if (resolver === undefined) return
  pending.delete(message.id)
  resolver(message)
})

let failed = false
function fail(message) {
  failed = true
  process.stderr.write(`✗ ${message}\n`)
}

/** 发一条 JSON-RPC 请求并等应答。 */
function request(method, params) {
  const id = ++nextId
  const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectPromise(new Error(`${method} 超时（5s）`))
    }, 5000)
    pending.set(id, (message) => {
      clearTimeout(timer)
      resolvePromise(message)
    })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
}

try {
  // 1) 握手
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cv-research-smoke', version: '1.0.0' },
  })
  if (init.error !== undefined) throw new Error(`initialize 失败：${JSON.stringify(init.error)}`)
  console.log(`✓ initialize：${init.result.serverInfo.name} ${init.result.serverInfo.version}（协议 ${init.result.protocolVersion}）`)
  notify('notifications/initialized')

  // 2) 工具表
  const list = await request('tools/list')
  const names = list.result.tools.map((tool) => tool.name)
  console.log(`✓ tools/list：${names.join(', ')}`)
  if (!names.includes('kb_search') || !names.includes('kb_summary')) {
    throw new Error('缺工具：S5 要求至少暴露 kb_search 与 kb_summary')
  }

  // 3) 真调 kb_summary（读的是真实 metadata.db）
  // ⚠️ MCP 的 tools/call 参数形状是 { name, arguments: {...} }——工具入参在 `arguments` 里。
  const summary = await request('tools/call', { name: 'kb_summary', arguments: { limit: 2 } })
  if (summary.result.isError === true) throw new Error(`kb_summary 失败：${summary.result.content[0].text}`)
  const summaryText = summary.result.content[0].text
  console.log(`✓ kb_summary：\n${summaryText.split('\n').slice(0, 12).join('\n')}`)

  // 4) 真调 kb_search：一次代表性查询，确认降级标记透出
  const search = await request('tools/call', {
    name: 'kb_search',
    arguments: { query: '跨数据集泛化 深层伪造检测', stores: ['problems', 'methods', 'failures'], limit: 3 },
  })
  if (search.result.isError === true) throw new Error(`kb_search 失败：${search.result.content[0].text}`)
  const payload = JSON.parse(search.result.content[0].text)
  const modes = payload.results.map((item) => `${item.store}=${item.mode}(${item.hits.length})`).join('  ')
  console.log(`✓ kb_search：${modes}`)
  if (payload.results.some((item) => item.mode !== 'keyword_only')) {
    fail('检索模式应为 keyword_only（本部署无 embedding），如实标注是硬要求')
  }
  const withHits = payload.results.filter((item) => item.hits.length > 0)
  if (withHits.length === 0) fail('三个库一条都没召回——查询串或 FTS 链路有问题')
  else console.log(`  命中示例：${withHits[0].hits[0].entry_id}  score=${withHits[0].hits[0].score.toFixed(3)}  ${withHits[0].hits[0].statement.slice(0, 40)}`)

  // 4b) 入参校验：缺必填参数要给可读懂的错误（客户端能自己改）
  const invalid = await request('tools/call', { name: 'kb_search', arguments: { stores: ['problems'] } })
  if (invalid.result.isError === true && invalid.result.content[0].text.includes('query')) {
    console.log('✓ 入参校验：缺 query → isError 且点名字段')
  } else {
    fail(`缺必填参数时应返回点名 isError，实际：${JSON.stringify(invalid.result).slice(0, 200)}`)
  }

  // 5) idea_score 在未接裁判时必须**明确拒绝**，而不是给假分数
  const scored = await request('tools/call', {
    name: 'idea_score',
    arguments: { statement: '用对比学习做跨生成器泛化', problem: '跨域泛化差', method: '对比学习' },
  })
  const scoreText = scored.result.content[0].text
  if (scored.result.isError === true && scoreText.includes('未配置 LLM 裁判')) {
    console.log('✓ idea_score：未接裁判时明确拒绝（不是假分数）')
  } else {
    fail(`idea_score 在没有裁判时应当明确拒绝，实际：${scoreText.slice(0, 200)}`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  child.stdin.end()
  child.kill()
}

if (stderrLines.length > 0) {
  console.log(`\n服务端 stderr（应只有日志，不含协议）：\n  ${stderrLines.join('\n  ')}`)
}
console.log(failed ? '\nS5 MCP CLIENT SMOKE FAILED' : '\nS5 MCP CLIENT SMOKE OK —— 另一个 MCP 客户端成功调用了 kb_search / kb_summary')
process.exit(failed ? 1 : 0)
