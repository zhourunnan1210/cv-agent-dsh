/**
 * Phase 1 · S-mineru spike —— MinerU API 可达性与 token 有效性的 L1 实证。
 *
 * ## 这个测试证明什么
 *
 * 2026-09-16 的工具栈决定是「MinerU **API 优先**，本地部署留作可切换的第二
 * 后端」。该决定的前提是"token 可用且服务可达"，本 spike 把这两条变成可重跑
 * 的断言，而不是一次性观察。
 *
 * 关键手法是**用错误类型区分鉴权与参数**，而不是靠"返回 200 就算成功"：
 *
 * - 带 token 发一个空 body → 期望 `-10002 field "url" is not set`：
 *   **过了鉴权**，被参数校验拦下。这正是 token 有效的证据。
 * - 不带 token 同一请求（对照组）→ 期望 **401**：证明鉴权确实生效，
 *   否则上一条的 200 什么也证明不了。
 *
 * 这样探测**不消耗额度**（不会真的创建解析任务）。
 *
 * ## 前置
 *
 * `MINERU_TOKEN` 环境变量。token 只从环境读取，不落盘、不入库（NOTICE 红线 #4）。
 *
 * 运行：
 *   $env:MINERU_TOKEN='<token>'; node tests/spike-mineru-api.mjs
 */
import { strict as assert } from 'node:assert'

const token = process.env.MINERU_TOKEN
assert.ok(token, 'MINERU_TOKEN 未设置')

const STANDARD = 'https://mineru.net/api/v4/extract/task'
const AGENT = 'https://mineru.net/api/v1/agent/parse/url'

async function post(url, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({}),
  })
  return { status: res.status, body: await res.text() }
}

// ── S-mineru-a：服务可达 ────────────────────────────────────────────────────
const docs = await fetch('https://mineru.net/apiManage/docs')
assert.equal(docs.status, 200, `mineru.net 不可达: ${docs.status}`)
console.log('✅ S-mineru-a: mineru.net 可达')

// ── S-mineru-b：带 token → 过鉴权，被参数校验拦下 ───────────────────────────
const authed = await post(STANDARD, { authorization: `Bearer ${token}` })
console.log('   带 token:', authed.status, authed.body.slice(0, 120))
assert.equal(authed.status, 200, '带 token 的请求应返回 200（参数校验属于业务层错误）')
const authedJson = JSON.parse(authed.body)
assert.equal(
  authedJson.code,
  -10002,
  `期望参数校验错误 -10002（证明过了鉴权），实际 code=${authedJson.code} msg=${authedJson.msg}`,
)
assert.match(authedJson.msg, /url/, '错误信息应指出缺少 url')
console.log('✅ S-mineru-b: token 有效 —— 通过鉴权，被 "url is not set" 参数校验拦下')

// ── S-mineru-c：不带 token（对照组）→ 鉴权拦截 ──────────────────────────────
const anon = await post(STANDARD, {})
console.log('   不带 token:', anon.status, anon.body.slice(0, 120))
assert.equal(anon.status, 401, '不带 token 应被 401 拦下 —— 否则 S-mineru-b 不构成证据')
console.log('✅ S-mineru-c: 对照组 401 —— 鉴权确实生效，S-mineru-b 成立')

// ── S-mineru-d：免 token 的 Agent API 也可达（小文件快速通道） ──────────────
const agent = await post(AGENT, {})
console.log('   Agent API:', agent.status, agent.body.slice(0, 140))
assert.equal(agent.status, 400, 'Agent API 应返回 400（参数错误）')
assert.match(agent.body, /url/, 'Agent API 的错误信封应指出缺少 url')
console.log('✅ S-mineru-d: 免 token 的 Agent API 可达（≤10MB / ≤20 页的快速通道）')

console.log('\nMINERU API SPIKE OK —— token 有效、服务可达、探测不消耗额度')
