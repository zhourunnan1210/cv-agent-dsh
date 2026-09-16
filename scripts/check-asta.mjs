/**
 * Asta MCP 启动前预检 —— 在宿主启动前确认"检索能力真的可用"。
 *
 * 为什么需要它：`mcp-asta` 行的三种失败（缺 key、缺代理 flag、代理没开）都不会阻止
 * 宿主启动，只会让 Agent **静默地没有检索工具**。这个预检把它们变成启动前的显式失败。
 *
 * 它做的事与 `tests/spike-asta-mcp.mjs` 的第一步相同（initialize → tools/list），
 * 但只走 HTTP、不装载 dsh，因此足够快，适合每次启动都跑。
 *
 * 环境依赖（由 scripts/start-dsh-web.ps1 设置）：
 *   ASTA_API_KEY          必填
 *   HTTPS_PROXY           Asta 域名在本网络被 Google 前置层拦截
 *   NODE_USE_ENV_PROXY=1  Node 24 的 fetch 缺它会直接忽略 HTTPS_PROXY
 *
 * 退出码：0 通过 / 1 失败 / 2 缺 ASTA_API_KEY
 */
const key = process.env.ASTA_API_KEY
if (!key) {
  console.error('  ✗ ASTA_API_KEY 未设置')
  process.exit(2)
}

const url = 'https://asta-tools.allen.ai/mcp/v1'

function payloads(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw) continue
    try { out.push(JSON.parse(raw)) } catch { /* ignore */ }
  }
  if (out.length === 0) { try { out.push(JSON.parse(text)) } catch { /* ignore */ } }
  return out
}

const headers = {
  'x-api-key': key,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
}

async function rpc(body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, payloads: payloads(await res.text()) }
}

try {
  const init = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-preflight', version: '1.0.0' } },
  })

  if (init.status !== 200) {
    console.error(`  ✗ Asta 返回 HTTP ${init.status}`)
    if (init.status === 403) {
      console.error('    → 代理没有生效。确认 HTTPS_PROXY 已设，且 **NODE_USE_ENV_PROXY=1**（缺后者时')
      console.error('      Node 24 的 fetch 会直接忽略 HTTPS_PROXY，实测只有代理 = 403）。')
    } else if (init.status === 401) {
      console.error('    → ASTA_API_KEY 无效或已失效。')
    }
    process.exit(1)
  }

  const server = init.payloads[0]?.result?.serverInfo
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = list.payloads.find((p) => p.result?.tools)?.result?.tools ?? []

  if (tools.length === 0) {
    console.error('  ✗ 连接成功但没取到任何工具')
    process.exit(1)
  }

  console.log(`  ✓ Asta 可用：${server?.name ?? 'Asta'} v${server?.version ?? '?'}，${tools.length} 个检索工具`)
  process.exit(0)
} catch (error) {
  console.error(`  ✗ 连不上 Asta：${error.message}`)
  console.error('    → 检查代理是否在运行、HTTPS_PROXY 是否指向正确的端口。')
  process.exit(1)
}
