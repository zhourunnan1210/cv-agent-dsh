/**
 * Phase 0 · S1 spike —— 工具白名单隔离的 L1 实证。
 *
 * ## 这个测试证明什么
 *
 * 子代理的工具白名单（`SubagentStartRequest.toolFilter`）最终落在
 * dsh-tools 的 `ToolRuntime.restrict(filter)` 上：委派运行时对子代理的 scope
 * 施加一次限制，子代理的模型可见目录来自 `schemas(scope)`。
 *
 * 本测试驱动**真实**的 `ToolRuntime` 与**真实**的 scope 原语
 * （从已安装的 dsh 0.1.5-rc.1 加载，非 mock），验证：
 *
 * 1. `allow` / `deny` 确实把工具从子 scope 的目录里移除；
 * 2. 限制只作用于子 scope，全局目录不受影响；
 * 3. 被限制的工具在子 scope 中读作「不存在」（而非报错）；
 * 4. **scope 自身注册的工具豁免于自身限制** —— 委派运行时正是把子代理的
 *    结构化输出工具注册进子代理自己的层，这个豁免是它得以工作的前提；
 * 5. 撤销限制的 disposer 生效；
 * 6. 无 scope 的上下文调用 `restrict()` 被**显式拒绝**（防止一次限制误伤
 *    所有 agent）；
 * 7. 空过滤器与未知工具名**报错**，而不是静默无效。
 *
 * ## 一个实现细节（对 Phase 1 有意义）
 *
 * `createScope()` 产生的上下文只带来 scope 标记，**不**继承注入特权：
 * 工具调用必须发生在一个声明了 `inject: ['tools']` 的插件内部。这正是
 * 委派运行时的形态 —— 它在子代理自己的创建窗口里注册结构化输出工具。
 *
 * ## 为什么不需要重启宿主
 *
 * 它测的是隔离原语（runtime + scope 级），不是端到端委派。端到端仍需宿主
 * 重启后用一个真实子代理验证（见勘误 §5.4）。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadPackage(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadPackage('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadPackage('@deepseek-ai/dsh-system-prompt')
const scopeModule = await loadPackage('@deepseek-ai/dsh-scope')
const cordis = await loadPackage('@deepseek-ai/cordis')

const Context = cordis.Context

/**
 * A dynamically imported package is a module namespace object, which Cordis does
 * not accept as a plugin. Two shapes occur in this deployment: named exports
 * (`apply` / `name` / `inject`, e.g. dsh-tools) and a default-exported plugin
 * class (e.g. dsh-system-prompt). Normalize both.
 */
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

/** 构造一个最小但真实的工具定义。 */
function makeTool(name) {
  return tools.defineTool({
    name,
    description: `spike tool ${name}`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => name,
  })
}

const app = new Context()

let runtime
await app.plugin({
  name: 'spike-host',
  apply(ctx) {
    // systemPrompt 必须先于 tools 存在：ToolRuntime 构造时即调用
    // `ctx.systemPrompt.tools(...)` 挂接目录来源。
    ctx.plugin(asPlugin(systemPromptModule))
    ctx.plugin({
      name: 'spike-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) {
        runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
      },
    })
  },
})

assert.ok(runtime !== undefined, 'ToolRuntime 未成功挂载')

// ── 全局层：三个模型可见工具 ────────────────────────────────────────────────
runtime.register(makeTool('spike_search'))
runtime.register(makeTool('spike_read'))
runtime.register(makeTool('spike_exec_code'))

const globalNames = runtime.schemas().map((s) => s.name).sort()
console.log('全局目录:', globalNames.join(', '))
assert.deepEqual(globalNames, ['spike_exec_code', 'spike_read', 'spike_search'])

// ── S1-g：无 scope 的上下文不得施加限制 ────────────────────────────────────
assert.throws(
  () => runtime.restrict({ deny: ['spike_exec_code'] }),
  /requires a scoped context/,
  '无 scope 时 restrict() 必须被拒绝',
)
console.log('✅ S1-g: 无 scope 上下文调用 restrict() 被显式拒绝（避免误伤所有 agent）')

// ── 子 scope：模拟一个被委派的子代理 ────────────────────────────────────────
const childKey = {}
const childScope = scopeModule.createScope(app, childKey)
const childCtx = childScope.ctx

assert.equal(scopeModule.scopeOf(childCtx), childKey, 'createScope 必须给上下文打上 scope 标记')
console.log('✅ S1-i: createScope 产生带 scope 标记的上下文')

const observed = {}

// 子代理的创建窗口：所有工具调用都必须在声明了 inject 的插件内进行。
await childCtx.plugin({
  name: 'spike-child-agent',
  inject: ['tools'],
  apply(agentCtx) {
    const key = scopeModule.scopeOf(agentCtx)
    observed.scopeKey = key
    observed.scopeMatches = key === childKey

    // ── S1-h：空过滤器必须报错 ──────────────────────────────────────────
    observed.emptyFilterThrows = (() => {
      try {
        agentCtx.tools.restrict({})
        return false
      } catch (error) {
        observed.emptyFilterError = error.message
        return true
      }
    })()

    // ── S1-j：未知工具名必须报错 ────────────────────────────────────────
    observed.unknownNameThrows = (() => {
      try {
        agentCtx.tools.restrict({ deny: ['spike_does_not_exist'] })
        return false
      } catch (error) {
        observed.unknownNameError = error.message
        return true
      }
    })()

    // 子代理自己层里的工具：模拟委派运行时注册的结构化输出工具
    agentCtx.tools.register(makeTool('spike_structured_output'))

    observed.restore = agentCtx.tools.restrict({ allow: ['spike_search', 'spike_read'] })

    observed.childNames = agentCtx.tools.schemas(key).map((s) => s.name).sort()
    observed.byName = agentCtx.tools.get('spike_exec_code', key)
    observed.ownTool = agentCtx.tools.get('spike_structured_output', key)
    observed.globalDuringRestriction = runtime.schemas().map((s) => s.name).sort()
  },
})

assert.equal(observed.scopeMatches, true, '插件内读到的 scope 必须与 createScope 的 key 一致')

assert.equal(observed.emptyFilterThrows, true, '空过滤器必须被拒绝')
console.log('✅ S1-h: restrict({}) 空过滤器被拒绝 —', observed.emptyFilterError)

assert.equal(observed.unknownNameThrows, true, '未知工具名必须被拒绝')
console.log('✅ S1-j: 过滤器出现未知工具名时报错 —', observed.unknownNameError)

console.log('子 scope 目录:', observed.childNames.join(', '))
assert.deepEqual(
  observed.childNames,
  ['spike_read', 'spike_search', 'spike_structured_output'],
  '子 scope 目录应只含被允许的工具 + 自身注册的工具',
)
console.log('✅ S1-a: allow 白名单生效，spike_exec_code 已从子 scope 目录移除')

assert.deepEqual(
  observed.globalDuringRestriction,
  ['spike_exec_code', 'spike_read', 'spike_search'],
  '全局目录在子 scope 受限期间必须完整',
)
console.log('✅ S1-b: 限制只作用于子 scope，全局目录不受影响')

assert.equal(observed.byName, undefined, '被限制掉的工具在子 scope 中应读作「不存在」')
console.log('✅ S1-c: 被 deny 的工具在子 scope 中解析为 undefined（而非报错）')

assert.notEqual(observed.ownTool, undefined, 'scope 自身注册的工具必须不受自身限制影响')
console.log('✅ S1-d: scope 自身注册的工具豁免于自身限制（结构化输出机制得以保留）')

// ── 撤销限制 ────────────────────────────────────────────────────────────────
await childCtx.plugin({
  name: 'spike-child-restore',
  inject: ['tools'],
  apply(agentCtx) {
    observed.restore()
    observed.afterRestore = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
  },
})
console.log('撤销限制后:', observed.afterRestore.join(', '))
assert.deepEqual(
  observed.afterRestore,
  ['spike_exec_code', 'spike_read', 'spike_search', 'spike_structured_output'],
  '撤销限制后子 scope 目录应恢复',
)
console.log('✅ S1-e: 撤销限制的 disposer 生效，目录恢复')

// ── deny 形式 ───────────────────────────────────────────────────────────────
const denyKey = {}
const denyScope = scopeModule.createScope(app, denyKey, { parent: childKey })
await denyScope.ctx.plugin({
  name: 'spike-child-deny',
  inject: ['tools'],
  apply(agentCtx) {
    agentCtx.tools.restrict({ deny: ['spike_exec_code'] })
    observed.denyNames = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
  },
})
console.log('deny 形式子 scope 目录:', observed.denyNames.join(', '))
// 该 scope 以 childKey 为父，因此继承了父 scope 自己注册的
// spike_structured_output —— 这正是「限制只过滤继承面，不动自身层」的另一面：
// 未被 deny 的祖先贡献会照常继承。preset 贡献的工具走的也是这条路径。
assert.deepEqual(observed.denyNames, ['spike_read', 'spike_search', 'spike_structured_output'])
console.log('✅ S1-k: deny 黑名单生效（spike_exec_code 移除）')

// ── S1-l：祖孙 scope 链上的限制叠加 ─────────────────────────────────────────
// 以仍处于限制中的 denyScope（deny exec_code）为父，孙 scope 再 deny search。
// 注意 childScope 的限制在上面已被 restore() 解除，不能用作演示叠加的父节点。
const grandKey = {}
const grandScope = scopeModule.createScope(app, grandKey, { parent: denyKey })
await grandScope.ctx.plugin({
  name: 'spike-grandchild',
  inject: ['tools'],
  apply(agentCtx) {
    agentCtx.tools.restrict({ deny: ['spike_search'] })
    observed.grandNames = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
  },
})
console.log('孙 scope 目录:', observed.grandNames.join(', '))
// scope 链为 grandKey -> denyKey -> childKey。叠加结果：
//   - denyKey 的 deny 移除 exec_code；
//   - grandKey 自身的 deny 移除 search；
//   - childKey 自身层注册的 structured_output 沿链继承，且不受任何限制影响。
assert.deepEqual(
  observed.grandNames,
  ['spike_read', 'spike_structured_output'],
  '限制求交集（exec_code 与 search 均被移除），而祖先自身层注册的工具沿链保持可见',
)
console.log('✅ S1-l: 祖孙 scope 链上的限制求交集；祖先自身层注册的工具沿链保持可见')

await childScope.dispose()
await denyScope.dispose()
await grandScope.dispose()

console.log('\nS1 SPIKE OK —— 工具白名单隔离在 runtime + scope 层得到实证')
