import { resolveDshModules, resolveDshPackage } from '../../../scripts/lib/dsh-root.mjs'
/**
 * 工具名契约的离线校验。
 *
 * ## 这个测试守什么
 *
 * 工具名会进入 `toolFilter` 与权限规则，而 `restrict()` 遇到**未知名字**会
 * 直接抛错（S1-j）。因此契约必须满足两类约束：
 *
 * 1. **形状**：`cvagent_*` 与 `mcp__asta__*` 各自的命名约定、内部不重复、
 *    互不冲突；
 * 2. **可接受性**：`SCOUT_ALLOWED_TOOLS` / `READER_ALLOWED_TOOLS` 作为
 *    `toolFilter.allow` 能被**真实** `ToolRuntime` 接受，且产出的目录与声明
 *    精确一致。
 *
 * ## 为什么这里不再校验"名字真在上游存在"
 *
 * 旧版本会驱动 dsh-ai4scholar 的构建产物，断言引用的名字真实存在于它的 38 个
 * 工具中。该 bundle 已于 2026-09-16 停用，而新后端的对齐对象是**远端 MCP
 * 服务器**——那需要网络、代理与 API key，不能放进离线测试套件。
 *
 * 这条断言没有丢，只是搬了家：`tests/spike-asta-mcp.mjs` 装载真实的
 * mcp-client，把远端实际注册的工具集与 `ASTA_TOOL_NAMES` 逐一对照。
 * 分工是：**离线测契约自洽，线上测契约与真实服务器对齐。**
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

// 校验的是**构建产物**：运行时真正加载的是 lib/，不是 src/。
import {
  ALL_CVAGENT_TOOLS,
  ASTA_TOOL_NAMES,
  ORCHESTRATOR_DENY_TOOLS,
  READER_ALLOWED_TOOLS,
  SCOUT_ALLOWED_TOOLS,
} from '../lib/tools/names.js'

const DSH = resolveDshModules()

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const scopeModule = await loadDsh('@deepseek-ai/dsh-scope')
const cordis = await loadDsh('@deepseek-ai/cordis')

const astaNames = Object.values(ASTA_TOOL_NAMES)

// ── 1. Asta 名字的形状与唯一性 ──────────────────────────────────────────────
assert.equal(new Set(astaNames).size, astaNames.length, 'Asta 工具名存在重复')
assert.equal(astaNames.length, 8, 'Asta 工具数应为 8（见 SKILL.md 意图路由表）')
for (const name of astaNames) {
  assert.match(name, /^mcp__asta__[a-z_]+$/, `Asta 工具名 ${name} 不符合 mcp__asta__<rawName> 约定`)
}
console.log(`✅ ${astaNames.length} 个 Asta 工具名符合 mcp__asta__<rawName> 约定且无重复`)

// ── 2. cvagent 名字的形状与唯一性 ──────────────────────────────────────────
assert.equal(new Set(ALL_CVAGENT_TOOLS).size, ALL_CVAGENT_TOOLS.length, 'cvagent 工具名存在重复')
for (const name of ALL_CVAGENT_TOOLS) {
  assert.match(name, /^cvagent_[a-z0-9_]+$/, `工具名 ${name} 不符合 cvagent_[a-z0-9_]+ 约定`)
}
console.log(`✅ ${ALL_CVAGENT_TOOLS.length} 个 cvagent 工具名符合 cvagent_[a-z0-9_]+ 约定且无重复`)

// ── 3. 两族互不重名（同名注册会失败） ──────────────────────────────────────
const collisions = ALL_CVAGENT_TOOLS.filter((name) => astaNames.includes(name))
assert.deepEqual(collisions, [], `cvagent 工具名与 Asta 工具冲突: ${collisions.join(', ')}`)
console.log('✅ cvagent 与 Asta 两族工具名无冲突')

// ── 4. 角色白名单必须是契约的子集（防拼写漂移） ────────────────────────────
for (const [label, list] of [
  ['SCOUT_ALLOWED_TOOLS', SCOUT_ALLOWED_TOOLS],
  ['READER_ALLOWED_TOOLS', READER_ALLOWED_TOOLS],
  ['ORCHESTRATOR_DENY_TOOLS', ORCHESTRATOR_DENY_TOOLS],
]) {
  const unknown = [...list].filter((name) => !astaNames.includes(name))
  assert.deepEqual(unknown, [], `${label} 含不在 ASTA_TOOL_NAMES 中的名字: ${unknown.join(', ')}`)
}
console.log('✅ 角色白名单与护栏名单全部是 ASTA_TOOL_NAMES 的子集')

// ── 5. 角色白名单作为 toolFilter.allow 能被真实 runtime 接受 ───────────────
// 用真实 ToolRuntime + 真实 scope 验证：过滤器里全是已知工具，不会触发
// 「unknown global tool」错误。工具用同名的桩定义登记——本测试关心的是
// **名字能否被注册表接受**，工具行为由各自的测试负责。
function asPlugin(module) {
  if (typeof module.apply === 'function') {
    return {
      ...(typeof module.name === 'string' ? { name: module.name } : {}),
      ...(module.inject === undefined ? {} : { inject: module.inject }),
      apply: module.apply,
    }
  }
  return module.default
}

function makeTool(name) {
  return tools.defineTool({
    name,
    description: `contract stub ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async () => name,
  })
}

const app = new cordis.Context()
let runtime
await app.plugin({
  name: 'names-host',
  apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    ctx.plugin({
      name: 'names-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) {
        runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
      },
    })
  },
})

// 模拟真实部署的工具面：全部 Asta 工具 + 全部 cvagent 工具。
for (const name of astaNames) runtime.register(makeTool(name))
for (const name of ALL_CVAGENT_TOOLS) runtime.register(makeTool(name))

async function catalogUnder(label, allow) {
  const scope = scopeModule.createScope(app, {})
  let seen = []
  await scope.ctx.plugin({
    name: `names-${label}`,
    inject: ['tools'],
    apply(agentCtx) {
      // 若白名单含未知名字，这一行会抛错。
      agentCtx.tools.restrict({ allow: [...allow] })
      seen = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
    },
  })
  await scope.dispose()
  return seen
}

const scoutCatalog = await catalogUnder('scout', SCOUT_ALLOWED_TOOLS)
assert.deepEqual(scoutCatalog, [...SCOUT_ALLOWED_TOOLS].sort(), 'Scout 白名单产出与声明不符')
console.log(`✅ Scout 白名单被真实 runtime 接受，目录精确为 ${scoutCatalog.length} 个检索工具`)

const readerCatalog = await catalogUnder('reader', READER_ALLOWED_TOOLS)
assert.deepEqual(readerCatalog, [...READER_ALLOWED_TOOLS].sort(), 'Reader 白名单产出与声明不符')
console.log(`✅ Reader 白名单被真实 runtime 接受，目录精确为 ${readerCatalog.length} 个取证工具`)

console.log('\nNAMES CONTRACT OK —— 工具名契约与真实运行时对齐')
