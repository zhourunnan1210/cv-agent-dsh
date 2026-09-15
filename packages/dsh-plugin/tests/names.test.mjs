/**
 * 工具名契约的 L1 校验。
 *
 * 两件事必须在运行时对齐，否则 Phase 1 会在运行时才炸：
 *
 * 1. `VENDOR_TOOL_NAMES` 里引用的名字必须真实存在于 dsh-ai4scholar 的 38 个工具中
 *    —— 因为 `toolFilter` 引用未知名字会被 `restrict()` 拒绝（S1-j）；
 * 2. `ALL_CVAGENT_TOOLS` 不得与宿主或 vip 厂商工具重名 —— 同名注册会失败。
 *
 * 本测试直接驱动真实的 dsh-ai4scholar 构建产物与真实的 `ToolRuntime`，
 * 不是字符串对比。
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

// 校验的是**构建产物**：运行时真正加载的是 lib/，不是 src/。
import { ALL_CVAGENT_TOOLS, VENDOR_TOOL_NAMES, SCOUT_ALLOWED_TOOLS } from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const requireVendor = createRequire(
  fileURLToPath(new URL('../../vendor/dsh-ai4scholar/package.json', import.meta.url)),
)
const vendor = await import(pathToFileURL(requireVendor.resolve('dsh-ai4scholar')).href)

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const scopeModule = await loadDsh('@deepseek-ai/dsh-scope')
const cordis = await loadDsh('@deepseek-ai/cordis')

// ── 1. 驱动真实 vendored 插件，取出它实际注册的工具名 ──────────────────────
const vendorTools = []
const fakeCtx = {
  tools: { register: (definition) => (vendorTools.push(definition), () => {}) },
  systemPrompt: { section: () => () => {} },
  commands: { register: () => () => {} },
  credentials: { resolve: () => undefined },
  inject: (_names, callback) => void callback,
  effect: () => () => {},
  get: () => undefined,
}

const vendorConfig = typeof vendor.Config === 'function' ? vendor.Config({}) : {}
vendor.apply(fakeCtx, vendorConfig)

const vendorNames = new Set(vendorTools.map((tool) => tool.name))
console.log(`vendored 插件注册工具数: ${vendorNames.size}`)
assert.equal(vendorNames.size, 38, 'vendored 插件应注册 38 个工具')

// ── 2. VENDOR_TOOL_NAMES 引用的每个名字都必须真实存在 ──────────────────────
const missing = Object.entries(VENDOR_TOOL_NAMES)
  .filter(([, name]) => !vendorNames.has(name))
  .map(([key, name]) => `${key} -> ${name}`)

assert.deepEqual(missing, [], `VENDOR_TOOL_NAMES 引用了不存在的工具名:\n${missing.join('\n')}`)
console.log(`✅ 契约引用的 ${Object.keys(VENDOR_TOOL_NAMES).length} 个 vendored 工具名全部真实存在`)

// ── 3. cvagent 工具名不与 vendored 工具重名 ────────────────────────────────
const collisions = ALL_CVAGENT_TOOLS.filter((name) => vendorNames.has(name))
assert.deepEqual(collisions, [], `cvagent 工具名与 vendored 工具冲突: ${collisions.join(', ')}`)
console.log(`✅ ${ALL_CVAGENT_TOOLS.length} 个 cvagent 工具名与 vendored 工具无冲突`)

// ── 4. cvagent 工具名内部不重复 ────────────────────────────────────────────
const unique = new Set(ALL_CVAGENT_TOOLS)
assert.equal(unique.size, ALL_CVAGENT_TOOLS.length, 'cvagent 工具名存在重复')
console.log('✅ cvagent 工具名无重复')

// ── 5. 命名约定：小写 + 下划线 + cvagent_ 前缀 ─────────────────────────────
for (const name of ALL_CVAGENT_TOOLS) {
  assert.match(name, /^cvagent_[a-z0-9_]+$/, `工具名 ${name} 不符合命名约定`)
}
console.log('✅ 全部 cvagent 工具名符合 cvagent_[a-z0-9_]+ 约定')

// ── 6. SCOUT_ALLOWED_TOOLS 作为 toolFilter.allow 能被真实 runtime 接受 ────
// 这一步用真实 ToolRuntime + 真实 scope 验证：过滤器里全是已知工具，
// 不会触发「unknown global tool」错误。
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

// 把 vendored 的 38 个工具全部登记进 runtime，模拟真实部署。
for (const definition of vendorTools) runtime.register(definition)

const scoutKey = {}
const scoutScope = scopeModule.createScope(app, scoutKey)
let scoutCatalog = []
await scoutScope.ctx.plugin({
  name: 'names-scout',
  inject: ['tools'],
  apply(agentCtx) {
    // 若 SCOUT_ALLOWED_TOOLS 含未知名字，这一行会抛错。
    agentCtx.tools.restrict({ allow: [...SCOUT_ALLOWED_TOOLS] })
    scoutCatalog = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
  },
})

assert.deepEqual(
  scoutCatalog,
  [...SCOUT_ALLOWED_TOOLS].sort(),
  'Scout 的 toolFilter.allow 应精确产出这 6 个工具',
)
console.log(`✅ Scout 白名单被真实 runtime 接受，目录精确为 ${scoutCatalog.length} 个检索工具`)
console.log('   ', scoutCatalog.join(', '))

await scoutScope.dispose()

console.log('\nNAMES CONTRACT OK —— 工具名契约与真实运行时对齐')
