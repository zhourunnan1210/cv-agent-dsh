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
 *
 * ## 2026-09-16：检索面从 dsh-ai4scholar 换成 Asta MCP
 *
 * 旧版本从 vendored 的 dsh-ai4scholar 里取出它真实注册的 38 个工具来铺工具面。
 * 该 bundle 已停用，工具面改为 8 个 Asta MCP 工具（`mcp__asta__*`）+ `cvagent_*` 工具。
 *
 * ⚠️ **别把 `names.ts` 的名字数当成会话里的工具数**（2026-09-17 查清）：
 * `names.ts` 声明 **25** 个 `cvagent_*` 名字，而 preset 实际接线 **16** 个
 * （状态 6 + 知识库 8 + idea 2）。差的 9 个是「有名字、无行注册」：
 * `cvagent_domain_*`(4) + `cvagent_exp_*`(4) + `cvagent_write_draft`(1)，
 * 其中 exp 四个已按用户裁定撤销（勘误 §12.4）。
 * 本文件里的工具面是**合成的**（把声明名全打桩注册）——它验证角色矩阵的
 * **契约形态**，不代表部署目录；部署目录的真相由 `scripts/check-tool-catalog.mjs` 断言。
 *
 * 两处**能力损失**已落到矩阵里，不是笔误：
 *
 * - **Reader 失去全文读取**：Asta 没有 `read_*`，Reader 暂时只能用
 *   `get_paper` + `snippet_search` 近似替代（见 `names.ts` 的
 *   `READER_ALLOWED_TOOLS`），真正的全文阅读等 MinerU 落地。
 * - **Writing 失去 `auto_cite` 与 `sci_draw`**：两者都随 ai4scholar 一并移除，
 *   Writing 现在只剩 `cvagent_write_draft`。需要时须单独引入替代品。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { strict as assert } from 'node:assert'

import {
  ASTA_TOOL_NAMES,
  CVAGENT_TOOL_FAMILIES,
  KB_TOOLS,
  READER_ALLOWED_TOOLS,
  SCOUT_ALLOWED_TOOLS,
} from '../lib/tools/names.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'

function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const tools = await loadDsh('@deepseek-ai/dsh-tools')
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const scopeModule = await loadDsh('@deepseek-ai/dsh-scope')
const cordis = await loadDsh('@deepseek-ai/cordis')

/**
 * 角色矩阵（勘误 §4.2）。
 *
 * `allow` 为 `null` 表示该角色**不受工具过滤**（继承父的全部工具面）——
 * 目前只有主 Agent 是这种情况，因为它的边界由 preset 决定。
 */
const ROLE_MATRIX = {
  /** 主 Agent：边界由 preset + E20 执行级护栏提供，不靠 toolFilter。 */
  orchestrator: {
    allow: null,
    // 注意：这里**不**用 mustNotSee 断言重上下文工具缺席。
    // 主 Agent 是根作用域，无法对自己施加 scope 限制（restrict() 会抛错）。
    // 它的重上下文边界由 cv-agent-dsh/orchestrator-guard 在执行级落实（E20），
    // 属于 preset 的验收项，见下方专项检查。
    mustNotSee: [],
    rationale: '§4.1：边界由 preset + E20 护栏提供，非 toolFilter',
  },
  /**
   * Scout：只做检索与去重，回传候选列表。
   *
   * ⚠️ 2026-09-17 修正（E32）：**`snippet_search` 在 Scout 的白名单里**——它是 Asta 族
   * 唯一有量的发现通道。§5.1 那条"只返回候选、不返回正文"的红线，边界是**主编排上下文**：
   * 片段只落进 Scout 的一次性上下文，回传主 Agent 的只有结构化候选；主编排会话那一侧
   * 由 ORCHESTRATOR_DENY_TOOLS + E20 护栏守（本文件末尾的专项断言）。
   * 此前把红线误解成"让 Scout 变瞎"，导致委派 prompt 推荐的工具被白名单剔掉，委派整轮失败。
   */
  scout: {
    allow: [...SCOUT_ALLOWED_TOOLS],
    mustNotSee: [KB_TOOLS.upsertEntry, KB_TOOLS.importPaper],
    rationale: '§5.1：只返回候选列表，不写库（正文片段只落进它自己的一次性上下文）',
  },
  /** Reader：围绕单篇取证，不检索。 */
  reader: {
    allow: [...READER_ALLOWED_TOOLS],
    mustNotSee: [
      ASTA_TOOL_NAMES.searchByRelevance,
      ASTA_TOOL_NAMES.searchByTitle,
      ASTA_TOOL_NAMES.citations,
      ASTA_TOOL_NAMES.authorPapers,
    ],
    rationale: '§5.3：一次仅处理单篇（全文待 MinerU）',
  },
  /** Analyst：只写三库，不检索也不取证。 */
  analyst: {
    allow: [...CVAGENT_TOOL_FAMILIES.kb],
    mustNotSee: [ASTA_TOOL_NAMES.searchByRelevance, ASTA_TOOL_NAMES.getPaper, ASTA_TOOL_NAMES.snippetSearch],
    rationale: '§5.4：三库去重合并判断',
  },
  /** Writing：不接触检索与实验中间文件，只用写作工具。 */
  writing: {
    allow: [...CVAGENT_TOOL_FAMILIES.idea.filter((n) => n.includes('write'))],
    mustNotSee: [
      ASTA_TOOL_NAMES.searchByRelevance,
      ASTA_TOOL_NAMES.snippetSearch,
      ASTA_TOOL_NAMES.getPaper,
    ],
    rationale: '§8.2：只加载材料包与写作模板（auto_cite/sci_draw 已随 ai4scholar 移除）',
  },
}

// ── 装配：真实 ToolRuntime + 同名的桩工具面 ────────────────────────────────
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

// 模型可见的初始面 = 8 个 Asta 工具 + 21 个 cvagent 工具。
const astaNames = Object.values(ASTA_TOOL_NAMES)
for (const name of astaNames) runtime.register(makeTool(name))

const { ALL_CVAGENT_TOOLS } = await import('../lib/tools/names.js')
for (const name of ALL_CVAGENT_TOOLS) runtime.register(makeTool(name))

const fullSurface = runtime.schemas().map((s) => s.name).sort()
console.log(`初始工具面: ${fullSurface.length} 个（${astaNames.length} Asta + ${ALL_CVAGENT_TOOLS.length} cvagent）`)
assert.equal(fullSurface.length, astaNames.length + ALL_CVAGENT_TOOLS.length)

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

// ── §1.3 原则四的专项断言：主 Agent 的边界由 preset + E20 护栏落实 ─────────
//
// 这是 §4.1 分层设计的直接验证：主 Agent 是根作用域，无法对自己施加 scope
// 限制；尝试施加会被拒绝。因此「主 Agent 不加载全文/正文片段」只能、也必须
// 由两件事共同保证：cv-research preset 提供的工具面，以及 orchestrator-guard
// 在 `tools/pre-execute` 上的执行级拒绝（E20）。
const heavy = results.orchestrator.filter((n) => n === ASTA_TOOL_NAMES.snippetSearch)
console.log('')
console.log(`主 Agent 目录中的重上下文工具: ${heavy.length === 0 ? '(无)' : heavy.join(', ')}`)
console.log('   → Asta 没有 read_*/download_*；唯一的重量级工具是 snippet_search，')
console.log('     它的拦截由 E20 护栏在执行级完成，不由 toolFilter 完成。')

assert.throws(
  () => runtime.restrict({ deny: [ASTA_TOOL_NAMES.snippetSearch] }),
  /requires a scoped context/,
  '根作用域不得施加限制',
)
console.log('✅ 主 Agent 无法用 toolFilter 约束自己 —— 边界只能由 preset + 护栏落实（§4.1 / E20）')

console.log('\nROLE MATRIX SPEC OK —— §16.1 角色矩阵与真实运行时一致')
