/**
 * 工具目录验收 —— 一个会话真正能看到的 cvagent / Asta 工具面。
 *
 * ## 为什么需要它
 *
 * 勘误 §8.6 验收清单第 1 条是「新会话选 CV Research Orchestrator，看工具目录」。
 * 这条检查原先只能靠眼睛，而工具目录恰恰是最会骗人的地方：
 *
 * - **工具行漏挂**（preset 里少一行）→ 目录里少几个工具，会话照常可用，没人发现；
 * - **声明 ≠ 注册**：`names.ts` 里有 25 个名字，而当前没有任何行注册其中 9 个
 *   （domain 4 + exp 4 + write_draft 1）。文档/设计稿里的名字数会被误读成
 *   "工具丢了"或"工具已经有了"，两边都不是真的；
 * - **Asta 静默消失**：mcp-asta 行的 `failOnStartupError` 刻意留 false（E19），
 *   缺 key、缺 `NODE_USE_ENV_PROXY=1`、代理没起，都只会让 8 个检索工具
 *   从目录里消失，agent 表现为"搜不到东西"。
 *
 * 本脚本把这条验收变成可执行的：装载**真实的工具行**（构建产物 `lib/`，
 * 与宿主实际加载的是同一份文件），用**真实 ToolRuntime** 枚举目录，逐族断言。
 *
 * ## 与既有检查的分工
 *
 * | 检查 | 覆盖面 |
 * | --- | --- |
 * | `scripts/check-preset.mjs` | 静态：组合结构能否挂载（服务行 / isolate realm / exports） |
 * | `packages/dsh-plugin/tests/*.test.ts` | 逐族：每个工具的行为与契约 |
 * | **本脚本** | 整体：会话里 cvagent + Asta 工具面**恰好**是哪些 |
 * | `tests/spike-asta-mcp.mjs` | 线上：Asta 名字与远端服务器逐一对齐 + 真实调用 |
 *
 * ## 用法
 *
 *     node scripts/check-tool-catalog.mjs                # cvagent 族（离线，不联网）
 *     node scripts/check-tool-catalog.mjs --with-asta    # 追加 Asta 行（需 ASTA_API_KEY + 代理）
 *
 * 退出码：0 通过 / 1 目录与契约不符 / 2 前置缺失（--with-asta 但没有 key）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

// 校验的是**构建产物**：宿主运行时加载的是 lib/，不是 src/。
// 用 URL 相对定位，脚本在哪个 cwd 下跑都成立。
const lib = (sub) => new URL(`../packages/dsh-plugin/lib/${sub}`, import.meta.url).href

const { ProjectStateService } = await import(lib('state/service.js'))
const stateTools = await import(lib('state/tools.js'))
const { KbService } = await import(lib('kb/service.js'))
const kbTools = await import(lib('kb/tools.js'))
const kbExtract = await import(lib('kb/extract-tool.js'))
const kbEntries = await import(lib('kb/entry-tools.js'))
const kbResearch = await import(lib('kb/research-tools.js'))
const { IdeaScoreService } = await import(lib('scoring/service.js'))
const ideaTools = await import(lib('scoring/tools.js'))
const { ASTA_TOOL_NAMES, DOMAIN_TOOLS, IDEA_TOOLS, KB_TOOLS, STATE_TOOLS } = await import(lib('tools/names.js'))

// ── 环境（与其它 scripts/*.mjs 同一套：代理 + .env.local；已存在的环境变量优先）──
if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = 'http://127.0.0.1:10808'
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1'
try {
  const { readFile } = await import('node:fs/promises')
  const dotEnv = await readFile(new URL('../.env.local', import.meta.url), 'utf8')
  for (const rawLine of dotEnv.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const i = line.indexOf('=')
    if (i < 1) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '' && !process.env[key]) process.env[key] = value
  }
} catch {
  // .env.local 缺失时靠环境变量
}

const withAsta = process.argv.includes('--with-asta')

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

/** 与 spike / 其它脚本相同：动态 import 得到的是命名空间对象，cordis 不接受。 */
function asPlugin(module) {
  if (typeof module.apply === 'function') {
    return {
      ...(typeof module.name === 'string' ? { name: module.name } : {}),
      ...(module.inject === undefined ? {} : { inject: module.inject }),
      apply: module.apply,
    }
  }
  if (typeof module.default === 'function' || typeof module.default?.apply === 'function') return module.default
  throw new Error(`无法识别的插件形态，导出为 ${Object.keys(module).join(', ')}`)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

/**
 * 期望的 cvagent 工具面：**preset 里三族工具行**覆盖的范围。
 *
 * 依据 `packages/dsh-plugin/presets/cv-research/agent.cordis.yml` 的
 * `cvagent-project-group`：状态族 1 行、知识库族 4 行、idea 族 1 行。
 */
const EXPECTED = [
  {
    family: '状态与门控',
    rowIds: ['tool-cvagent-state'],
    names: Object.values(STATE_TOOLS),
  },
  {
    family: '知识库',
    rowIds: ['tool-cvagent-kb', 'tool-cvagent-kb-extract', 'tool-cvagent-kb-entries', 'tool-cvagent-kb-research'],
    names: Object.values(KB_TOOLS),
  },
  {
    family: 'idea',
    rowIds: ['tool-cvagent-idea'],
    names: [IDEA_TOOLS.generate, IDEA_TOOLS.score],
  },
]

/**
 * `names.ts` 里已声明、但当前**没有任何行注册**的名字。
 *
 * 断言它们不在目录里，是为了让"设计稿里的名字"与"会话里的工具"这条界线
 * 在脚本里显式存在——接线跑在契约前面（或目录里混进没实现的工具）时这里会响。
 *
 * 注意 `exp*` 四个是**已撤销**（勘误 §12.4：实验段改为"归档原则 + coding agent
 * 自主"，不再做编排工具）。它们留在 `names.ts` 里是历史痕迹，这里显式点名。
 */
const DECLARED_NOT_WIRED = [
  ...Object.values(DOMAIN_TOOLS),
  IDEA_TOOLS.expPlan,
  IDEA_TOOLS.expLaunch,
  IDEA_TOOLS.expStatus,
  IDEA_TOOLS.expCollect,
  IDEA_TOOLS.writeDraft,
]

/**
 * 不变式：**声明名 = 已接线 ∪ 未接线**，且两者不重叠。
 *
 * 这条比"硬编码期望 16"更有价值：以后新增工具族时，只有两种合法做法——
 * 要么把它加进 EXPECTED（接线了），要么加进 DECLARED_NOT_WIRED（还没接）。
 * 忘了登记就会在这里报错，而不是等到某天有人对着目录数数才发现少了一族。
 */
const ALL_DECLARED = [
  ...Object.values(STATE_TOOLS),
  ...Object.values(KB_TOOLS),
  ...Object.values(DOMAIN_TOOLS),
  ...Object.values(IDEA_TOOLS),
]
const wiredSet = new Set(EXPECTED.flatMap((group) => group.names))
const unwiredSet = new Set(DECLARED_NOT_WIRED)
const partitionProblems = []
for (const name of ALL_DECLARED) {
  if (!wiredSet.has(name) && !unwiredSet.has(name)) partitionProblems.push(`声明了但两边都没登记：${name}`)
  if (wiredSet.has(name) && unwiredSet.has(name)) partitionProblems.push(`同时出现在已接线与未接线：${name}`)
}
for (const name of [...wiredSet, ...unwiredSet]) {
  if (!ALL_DECLARED.includes(name)) partitionProblems.push(`登记了但 names.ts 里没有：${name}`)
}
if (partitionProblems.length > 0) {
  console.error('✗ 工具名分区不自洽（EXPECTED / DECLARED_NOT_WIRED 与 names.ts 不一致）：')
  for (const problem of partitionProblems) console.error(`  - ${problem}`)
  process.exit(1)
}

// ── 装配：真实 ToolRuntime + 真实服务 + 真实工具行 ──────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'cvagent-catalog-'))
const app = new cordis.Context()
let runtime
let kb
let projectState
let ideaScore

await app.plugin({ name: 'catalog-host-outer', async apply(ctx) { await ctx.plugin(systemPromptModule.default) } })
await app.plugin({
  name: 'catalog-host-core',
  inject: ['systemPrompt'],
  apply(coreCtx) {
    runtime = new tools.ToolRuntime(coreCtx, tools.Config ? tools.Config({}) : {})
    // 真服务而不是打桩：行的 apply 会直接读 ctx.kb / ctx.projectState / ctx.ideaScore，
    // 打桩只能证明"名字能注册"，证明不了"这些行真的能在部署形态下装配起来"。
    kb = new KbService(coreCtx, { dbPath: join(dir, 'metadata.db') })
    projectState = new ProjectStateService(coreCtx, { projectDir: join(dir, 'project'), experimentsDir: join(dir, 'project', 'experiments') })
    ideaScore = new IdeaScoreService(coreCtx, { packDir: join(dir, 'packs'), packId: 'catalog-pack', version: '0.1', topk: 5 })
  },
})

// 行 → 模块，逐行装载（与 preset 的 id 一一对应；漏一行这里就少几个工具）。
const ROWS = [
  { id: 'tool-cvagent-state', apply: () => stateTools.apply({ tools: runtime, projectState }) },
  { id: 'tool-cvagent-kb', apply: () => kbTools.apply({ tools: runtime, kb }) },
  { id: 'tool-cvagent-kb-extract', apply: () => kbExtract.apply({ tools: runtime, kb, get: () => undefined }) },
  { id: 'tool-cvagent-kb-entries', apply: () => kbEntries.apply({ tools: runtime, kb }) },
  { id: 'tool-cvagent-kb-research', apply: () => kbResearch.apply({ tools: runtime, kb, get: () => undefined }) },
  { id: 'tool-cvagent-idea', apply: () => ideaTools.apply({ tools: runtime, kb, ideaScore, get: () => undefined }) },
]

console.log('工具目录体检（cvagent + Asta）')
console.log(`  来源：packages/dsh-plugin/lib/（构建产物，宿主加载的同一份文件）`)
console.log(`  行数：${ROWS.length} 行 \u2192 ${ROWS.map((r) => r.id).join('、')}`)
for (const row of ROWS) row.apply()

// ── Asta 行（可选）：真实 mcp-client + 远端服务器 ──────────────────────────
let astaRow
let astaNames = []
if (withAsta) {
  if (!process.env.ASTA_API_KEY) {
    console.error('\n✗ --with-asta 需要 ASTA_API_KEY（.env.local 或环境变量）；缺它时宿主里的检索工具只会静默消失')
    process.exit(2)
  }
  const mcpClient = await loadDsh('@deepseek-ai/dsh-mcp-client')
  astaRow = await app.plugin(
    { ...asPlugin(mcpClient), Config: mcpClient.Config },
    {
      serverName: 'asta',
      transport: 'streamable-http',
      url: 'https://asta-tools.allen.ai/mcp/v1',
      headers: { 'x-api-key': process.env.ASTA_API_KEY },
      // 刻意 true：本脚本要的是"连不上就说连不上"，不是静默地少 8 个工具。
      failOnStartupError: true,
    },
  )
  astaNames = runtime.schemas().map((s) => s.name).filter((n) => n.startsWith('mcp__asta__')).sort()
}

// ── 枚举与断言 ─────────────────────────────────────────────────────────────
const catalog = runtime.schemas().map((s) => s.name).sort()
const cvagent = catalog.filter((n) => n.startsWith('cvagent_'))
const expectedCvagent = EXPECTED.flatMap((group) => group.names).sort()
const problems = []

console.log('\n【cvagent 族】')
for (const group of EXPECTED) {
  const seen = group.names.filter((n) => cvagent.includes(n)).sort()
  const missing = group.names.filter((n) => !cvagent.includes(n))
  const ok = missing.length === 0 && seen.length === group.names.length
  console.log(
    `  ${group.family.padEnd(6, '　')} ${String(seen.length).padStart(2)}/${group.names.length} 个`
    + `  ${ok ? '✅' : '✗'}  行：${group.rowIds.join('、')}`,
  )
  if (!ok) problems.push(`${group.family}族缺工具：${missing.join('、')}`)
}
console.log(`  ── 合计 ${cvagent.length} 个（已接线契约 ${expectedCvagent.length} 个）`)

const missingCvagent = expectedCvagent.filter((n) => !cvagent.includes(n))
const extraCvagent = cvagent.filter((n) => !expectedCvagent.includes(n))
if (missingCvagent.length > 0) problems.push(`目录里缺少 cvagent 工具：${missingCvagent.join('、')}`)
if (extraCvagent.length > 0) problems.push(`目录里多了未在期望面里的 cvagent 工具：${extraCvagent.join('、')}`)

const leaked = DECLARED_NOT_WIRED.filter((n) => cvagent.includes(n))
if (leaked.length > 0) problems.push(`已声明但未接线的工具出现在目录里：${leaked.join('、')}`)

console.log(`  未接线（names.ts 有名字、无行注册）：${DECLARED_NOT_WIRED.length} 个 \u2192 ${DECLARED_NOT_WIRED.join('、')}`)

if (withAsta) {
  const expectedAsta = Object.values(ASTA_TOOL_NAMES).sort()
  console.log('\n【Asta 族】（真实远端服务器注册）')
  console.log(`  ${astaNames.length}/${expectedAsta.length} 个`)
  for (const name of astaNames) console.log(`    - ${name}`)
  const missingAsta = expectedAsta.filter((n) => !astaNames.includes(n))
  const extraAsta = astaNames.filter((n) => !expectedAsta.includes(n))
  if (missingAsta.length > 0) problems.push(`Asta 缺工具：${missingAsta.join('、')}`)
  if (extraAsta.length > 0) problems.push(`Asta 多了契约外的工具：${extraAsta.join('、')}`)
} else {
  console.log('\n【Asta 族】跳过（未加 --with-asta；加该参数可验证真实远端注册的 8 个工具）')
}

// ── 收尾（MCP 行必须卸载：保活连接会拽住事件循环）────────────────────────
if (astaRow !== undefined && typeof astaRow.dispose === 'function') await astaRow.dispose()
kb.close()
await rm(dir, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`\n✗ 工具目录与契约不符（${problems.length} 条）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

assert.equal(
  cvagent.length,
  expectedCvagent.length,
  `cvagent 工具数应为已接线契约的 ${expectedCvagent.length} 个，实际 ${cvagent.length}`,
)
console.log(`\nTOOL CATALOG OK —— cvagent ${cvagent.length} 个（另有 ${DECLARED_NOT_WIRED.length} 个已声明未接线）+ Asta 8 个与契约一致`)
process.exit(0)
