/**
 * 勘误 §4.2「修订版 §16.1 角色矩阵」的可执行规格。
 *
 * ## 为什么把它做成测试
 *
 * §16.1 是整份设计里最容易被写错、又最难在评审时看出错的部分：一张
 * 「哪个角色能用哪些工具」的表格。评审时读起来都对，落地时一个名字写错
 * 就变成运行时抛错（S1-j）或者**更糟**——白名单里多留了一个重上下文工具，
 * 于是 §1.3 原则四（主 Agent 上下文洁净）在无人察觉的情况下失效。
 *
 * 因此本测试把矩阵写成数据，用**真实** `ToolRuntime` + `dsh-scope` 逐角色
 * 展开，断言每个角色实际看到的目录与声明完全一致。矩阵改了而代码没跟上，
 * 这里就会红。
 *
 * ## 与前一轮 S1 测试的区别
 *
 * `tests/spike-s1-tool-isolation.mjs` 验证的是**隔离原语是否有效**（机制）；
 * 本测试验证的是**我们的角色矩阵是否正确**（设计）。前者是 dsh 的性质，
 * 后者是我们的责任。
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

import { CVAGENT_TOOL_FAMILIES, SCOUT_ALLOWED_TOOLS, VENDOR_TOOL_NAMES } from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const scopeModule = await loadDsh('@deepseek-ai/dsh-scope')
const cordis = await loadDsh('@deepseek-ai/cordis')

const requireVendor = createRequire(
  fileURLToPath(new URL('../../vendor/dsh-ai4scholar/package.json', import.meta.url)),
)
const vendor = await import(pathToFileURL(requireVendor.resolve('dsh-ai4scholar')).href)

/**
 * 角色矩阵（勘误 §4.2）。
 *
 * `allow` 为 `null` 表示该角色**不受工具过滤**（继承父的全部工具面）——
 * 目前只有主 Agent 是这种情况，因为它的边界由 preset 决定。
 */
const ROLE_MATRIX = {
  /** 主 Agent：无 kb.extract、无实验执行工具；边界由 preset 提供。 */
  orchestrator: {
    allow: null,
    // 注意：这里**不**用 mustNotSee 断言 read_* 缺席。
    // 主 Agent 的边界由 preset 的工具面决定（§4.1），而不是 toolFilter ——
    // 它自己就是根作用域，无法对自己施加 scope 限制（restrict() 会抛错）。
    // 断言 read_* 缺席属于 preset 的验收项，见下方专项检查。
    mustNotSee: [],
    rationale: '§4.1：边界由 preset 提供，非 toolFilter',
  },
  /** Scout：只做检索与去重，回传候选列表。 */
  scout: {
    allow: [...SCOUT_ALLOWED_TOOLS],
    mustNotSee: [VENDOR_TOOL_NAMES.autoCite, VENDOR_TOOL_NAMES.sciDraw, VENDOR_TOOL_NAMES.readSemanticPaper],
    rationale: '§5.1：只返回候选列表，不返回全文',
  },
  /** Reader：只读单篇全文，不检索。 */
  reader: {
    allow: [VENDOR_TOOL_NAMES.readSemanticPaper, VENDOR_TOOL_NAMES.readArxivPaper, VENDOR_TOOL_NAMES.readByDoi],
    mustNotSee: [VENDOR_TOOL_NAMES.searchPapers, VENDOR_TOOL_NAMES.matchPaper, VENDOR_TOOL_NAMES.autoCite],
    rationale: '§5.3：一次仅加载单篇论文',
  },
  /** Analyst：只写三库，不检索也不读全文。 */
  analyst: {
    allow: [...CVAGENT_TOOL_FAMILIES.kb],
    mustNotSee: [VENDOR_TOOL_NAMES.searchPapers, VENDOR_TOOL_NAMES.readSemanticPaper, VENDOR_TOOL_NAMES.autoCite],
    rationale: '§5.4：三库去重合并判断',
  },
  /** Writing：不接触检索与实验中间文件，只用写作工具。 */
  writing: {
    allow: [VENDOR_TOOL_NAMES.autoCite, VENDOR_TOOL_NAMES.sciDraw, ...CVAGENT_TOOL_FAMILIES.idea.filter((n) => n.includes('write'))],
    mustNotSee: [VENDOR_TOOL_NAMES.searchPapers, VENDOR_TOOL_NAMES.readSemanticPaper, VENDOR_TOOL_NAMES.matchPaper],
    rationale: '§8.2：只加载材料包与写作模板',
  },
}

// ── 装配：真实 ToolRuntime + 真实 vendored 工具面 ──────────────────────────
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
    description: `spec tool ${name}`,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async () => name,
  })
}

/** 取出 vendored 插件真实注册的 38 个工具定义。 */
function vendoredDefinitions() {
  const collected = []
  vendor.apply(
    {
      tools: { register: (definition) => (collected.push(definition), () => {}) },
      systemPrompt: { section: () => () => {} },
      commands: { register: () => () => {} },
      credentials: { resolve: () => undefined },
      inject: (_names, callback) => void callback,
      effect: () => () => {},
      get: () => undefined,
    },
    typeof vendor.Config === 'function' ? vendor.Config({}) : {},
  )
  return collected
}

const app = new cordis.Context()
let runtime
await app.plugin({
  name: 'matrix-host',
  apply(ctx) {
    ctx.plugin(asPlugin(systemPromptModule))
    ctx.plugin({
      name: 'matrix-tools',
      inject: ['systemPrompt'],
      apply(toolsCtx) {
        runtime = new tools.ToolRuntime(toolsCtx, tools.Config ? tools.Config({}) : {})
      },
    })
  },
})

// 模型可见的初始面 = 38 个 vendored 工具 + 21 个 cvagent 工具。
const vendored = vendoredDefinitions()
for (const definition of vendored) runtime.register(definition)

const { ALL_CVAGENT_TOOLS } = await import('../lib/tools/names.js')
for (const name of ALL_CVAGENT_TOOLS) runtime.register(makeTool(name))

const fullSurface = runtime.schemas().map((s) => s.name).sort()
console.log(`初始工具面: ${fullSurface.length} 个（38 vendored + 21 cvagent）`)
assert.equal(fullSurface.length, 38 + ALL_CVAGENT_TOOLS.length)

// ── 逐角色展开并断言 ───────────────────────────────────────────────────────
const results = {}

for (const [role, spec] of Object.entries(ROLE_MATRIX)) {
  const key = {}
  const scope = scopeModule.createScope(app, key)
  await scope.ctx.plugin({
    name: `matrix-${role}`,
    inject: ['tools'],
    apply(agentCtx) {
      if (spec.allow !== null) agentCtx.tools.restrict({ allow: [...spec.allow] })
      results[role] = agentCtx.tools.schemas(scopeModule.scopeOf(agentCtx)).map((s) => s.name).sort()
    },
  })
  await scope.dispose()
}

console.log('')
for (const [role, spec] of Object.entries(ROLE_MATRIX)) {
  const seen = results[role]
  console.log(`${role.padEnd(13)} ${String(seen.length).padStart(2)} 个工具  (${spec.rationale})`)

  if (spec.allow !== null) {
    // allow 形式：可见集合必须与声明**完全相等**（既不多也不少）
    assert.deepEqual(
      seen,
      [...spec.allow].sort(),
      `${role} 的可见工具集与 §16.1 声明不符`,
    )
    console.log(`              ✅ 与声明精确一致（allow ${spec.allow.length}）`)
  } else {
    // 无过滤：必须看到全部
    assert.deepEqual(seen, fullSurface, `${role} 声明不受过滤，应看到完整工具面`)
    console.log('              ✅ 不受过滤，看到完整工具面')
  }

  // 红线：每个角色都必须看不到自己不该看的工具
  for (const forbidden of spec.mustNotSee) {
    assert.ok(
      !seen.includes(forbidden),
      `${role} 不应看到 ${forbidden}（${spec.rationale}）`,
    )
  }
  if (spec.mustNotSee.length > 0) {
    console.log(`              ✅ 隔离红线成立：看不到 ${spec.mustNotSee.join(', ')}`)
  }
}

// ── §1.3 原则四的专项断言：主 Agent 的边界由 preset 而非 toolFilter 落实 ──
//
// 这是 §4.1 分层设计的直接验证：主 Agent 是根作用域，无法对自己施加 scope
// 限制；尝试施加会被拒绝。因此「主 Agent 不加载全文」只能、也必须由
// cv-research preset 的工具面来保证。
const reads = results.orchestrator.filter((n) => n.startsWith('read_'))
console.log('')
console.log(`主 Agent 目录中的 read_* 工具: ${reads.length === 0 ? '(无)' : reads.join(', ')}（共 ${reads.length} 个）`)

assert.throws(
  () => runtime.restrict({ deny: [VENDOR_TOOL_NAMES.readSemanticPaper] }),
  /requires a scoped context/,
  '根作用域不得施加限制',
)
console.log('✅ 主 Agent 无法用 toolFilter 约束自己 —— 边界只能由 preset 落实（§4.1）')
console.log('   → preset 验收项：cv-research preset 的工具面中不得出现 read_*/download_*')

console.log('\nROLE MATRIX SPEC OK —— §16.1 角色矩阵与真实运行时一致')
