/**
 * 预设**行级挂载探针**（新进程，真 Cordis，真 loader 语义）。
 *
 * ## 它补的是哪一块
 *
 * `scripts/check-preset.mjs` 是**静态**检查（结构、isolate、exports），看不见
 * 运行期错误；而 2026-09-17 的事故恰恰是运行期的：
 *
 *     failed to apply loader entry cvagent-instructions: cannot get property
 *     "systemPrompt" without inject
 *
 * 用户看到的是「无法切换到 CV Research Orchestrator」，整份 preset 不可用。
 *
 * 本探针把 preset 里**属于本包的行**逐行拿出来，在**真 Cordis** 上按**这一行自己
 * 声明的 inject** 挂载一次：
 * - 漏声明 → Cordis 抛 `cannot get property ... without inject`（事故原样复现）；
 * - 模块导入失败、apply 抛异常 → 同样在这里暴露。
 *
 * 为什么必须在**新进程**里跑：宿主的 ESM 模块缓存按 URL 命中，宿主一旦导入过
 * 某个行模块（哪怕 apply 失败），进程内就再也读不到新构建的 `lib/`。在宿主里
 * 复查只会重放旧模块的旧错误（E21）。所以验证"改完了没有"必须在独立进程做。
 *
 * 为什么不用宿主服务而用 stub：探针要回答的是"这行的依赖声明对不对"，不是
 * "业务跑得通吗"。缺哪个服务就用 stub 补哪个**是故意的**——真服务由真宿主提供；
 * 这里 stub 只让 apply 能跑到它真正的属性访问点。
 *
 * ## 已知边界
 *
 * - 只覆盖 `cv-agent-dsh/*` 行（本包自己的 20 行）；`@deepseek-ai/*` 的行是
 *   部署自带的，已被 `standard` 等预设反复挂载过。
 * - 服务行会在临时目录里真的建库/建状态文件（cwd 已切到临时目录），
 *   因此既能当挂载检查，也顺带跑一遍迁移。
 * - 配置 schema 校验由 loader 做，这里不覆盖（本包行的 config 都是显式或留空）。
 *
 * 用法：node scripts/probe-preset-rows.mjs [preset 文件路径]
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_ROOT = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
const require = createRequire(DSH_ROOT + '/package.json')

const presetPath = resolve(process.argv[2] ?? 'packages/dsh-plugin/presets/cv-research/agent.cordis.yml')
const packageJsonPath = resolve(dirname(presetPath), '..', '..', 'package.json')

const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const yaml = await import(pathToFileURL(require.resolve('yaml')).href)

/** `!!js` 是 dsh 的自定义标签，yaml 不认；这里只关心结构与行名，不求解值。 */
function parsePreset(text) {
  const previousWarn = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('Unresolved tag')) return
    return previousWarn.call(process, warning, ...rest)
  }
  try {
    return yaml.parse(text, { merge: true })
  } finally {
    process.emitWarning = previousWarn
  }
}

/** 展平成 `{ id, name, config, disabled }` 列表（group 递归进去）。 */
function flattenRows(rows, config, found = []) {
  for (const row of rows ?? []) {
    if (row?.name === 'cordis:group' && Array.isArray(row.config)) {
      flattenRows(row.config, config, found)
      continue
    }
    if (row?.name !== undefined && row.disabled !== true) {
      found.push({ id: row.id, name: row.name, config: row.config })
    }
  }
  return found
}

const exportsMap = JSON.parse(await readFile(packageJsonPath, 'utf8')).exports
const rows = flattenRows(parsePreset(await readFile(presetPath, 'utf8')))
const ourRows = rows.filter((row) => row.name.startsWith('cv-agent-dsh/'))

/**
 * 服务 stub：apply 阶段真正被调用到的只有少数几个方法。
 * 这里只实现"会被调用"的面，其余交给业务在真实宿主里跑。
 */
function makeStub(serviceName) {
  if (serviceName === 'systemPrompt') return { section: () => () => {} }
  if (serviceName === 'tools') return { register: () => () => {} }
  if (serviceName === 'agents') return { list: () => [] }
  if (serviceName === 'skills') return { list: () => [] }
  // kb / projectState / ideaScore：apply 阶段只保存引用，方法在工具执行时才调。
  return {}
}

/** 行模块里声明的依赖（功能型插件用命名导出，服务类用 static inject）。 */
function declaredInject(mod) {
  if (Array.isArray(mod.inject)) return [...mod.inject]
  const exported = mod.default
  if (Array.isArray(exported?.inject)) return [...exported.inject]
  return []
}

/**
 * 行模块 → Cordis 插件。
 *
 * E18-② 的原文是「必须有 `default`（插件类）**或**命名 `apply` 导出」——
 * 本包的 6 个工具行走的都是后者：模块里只有 `export const inject / export function apply`，
 * 于是 loader 把**模块命名空间对象本身**当插件交给 Cordis（它正好有 name/inject/apply 三个字段）。
 * 因此这里的回退不是宽容，而是**生产路径的原样**：命名导出就必须靠命名空间对象挂载，
 * 而命名空间对象读的也正好是命名 `inject`——漏声明依然会抛。
 */
function asPlugin(mod, rowId) {
  if (mod.default !== undefined) {
    const exported = mod.default
    const isClass = typeof exported === 'function' && /^class\s/.test(Function.prototype.toString.call(exported))
    // 服务类：交给 Cordis 自己读 static inject / static Config。
    if (isClass) return exported
    return { name: rowId, inject: declaredInject(mod), apply: exported }
  }
  if (typeof mod.apply === 'function') return mod
  return undefined
}

// 服务行会在默认路径上真的建库/建状态文件 —— 把 cwd 切到临时目录，别碰真实数据。
const scratch = await mkdtemp(join(tmpdir(), 'cvagent-probe-'))
process.chdir(scratch)
// 复刻仓库的最小目录形状：kb 的默认库路径是 `data/papers/metadata.db`，
// 上级目录不存在时 sqlite 只会报 "unable to open database file"。
await mkdir(join(scratch, 'data', 'papers'), { recursive: true })

console.log(`预设：${presetPath}`)
console.log(`本包行数：${ourRows.length} / 全部可启用行 ${rows.length}`)
console.log(`临时工作目录：${scratch}\n`)

const failures = []
let checked = 0
let importCounter = 0

for (const row of ourRows) {
  const subpath = `./${row.name.slice('cv-agent-dsh/'.length)}`
  const entry = exportsMap[subpath]
  const label = `${row.id} (${row.name})`

  if (entry === undefined) {
    failures.push({ row: label, stage: 'exports', message: `package.json 里没有 ${subpath}` })
    console.log(`✗ ${label}\n    阶段=exports：package.json 缺少 ${subpath}`)
    continue
  }

  const modulePath = resolve(dirname(packageJsonPath), entry.default)
  if (!existsSync(modulePath)) {
    failures.push({ row: label, stage: 'build', message: `未构建：${modulePath}` })
    console.log(`✗ ${label}\n    阶段=build：${modulePath} 不存在（先 pnpm -C packages/dsh-plugin run build）`)
    continue
  }

  // cache-bust：保证探的是刚构建的 lib，而不是同进程里更早导入过的旧模块。
  importCounter += 1
  let mod
  try {
    mod = await import(`${pathToFileURL(modulePath).href}?probe=${importCounter}`)
  } catch (error) {
    failures.push({ row: label, stage: 'import', message: error.message })
    console.log(`✗ ${label}\n    阶段=import：${error.message}`)
    continue
  }

  const injectList = declaredInject(mod)
  const plugin = asPlugin(mod, row.id)
  if (plugin === undefined) {
    failures.push({
      row: label,
      stage: 'export',
      message: '既没有 default 导出，也没有命名 apply 导出（E18-②：loader 两者取其一，都没有就装不上）',
    })
    console.log(`✗ ${label}\n    阶段=export：既没有 default 也没有命名 apply`)
    continue
  }

  const app = new cordis.Context()
  // ⚠️ 服务必须由一个**宿主行**（root 的子 fiber）发布，不能用 `app.provide` 直接挂在
  // root 上——实测（scripts 里的形状实验）：
  //   root.provide('systemPrompt') + 行 inject=[]  → **挂载成功**（探针抓不到任何东西）
  //   子 fiber 里 ctx.provide(...)  + 行 inject=[]  → 抛 cannot get property ...
  // 差别就是 Cordis 的依赖检查走的是 fiber 的 store：挂在 root 上的值沿树可见，
  // 绕过了 inject；而生产里 systemPrompt/tools 都由宿主行发布，preset 行是另一棵子树
  // ——正是后一种形状。探针若用前一种，就成了"永远不会失败"的假检查。
  // （这正是本次事故的教训重复一次：守卫必须能失败，且必须证明它能失败。）
  for (const serviceName of new Set(['systemPrompt', 'tools', ...injectList])) {
    await app.plugin({
      name: `probe-host:${serviceName}`,
      apply(ctx) {
        ctx.provide(serviceName, makeStub(serviceName))
      },
    })
  }

  try {
    await app.plugin(plugin, row.config ?? {})
    checked += 1
    console.log(`✓ ${label}  inject=[${injectList.join(',')}]`)
  } catch (error) {
    failures.push({ row: label, stage: 'apply', message: error.message })
    console.log(`✗ ${label}  inject=[${injectList.join(',')}]\n    阶段=apply：${error.message}`)
  }
}

await rm(scratch, { recursive: true, force: true }).catch(() => {})

console.log(`\n挂载成功 ${checked}/${ourRows.length}`)
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 行挂载失败（这些都会让整个 preset 在宿主里挂载失败）：`)
  for (const failure of failures) console.error(`  - [${failure.stage}] ${failure.row}：${failure.message}`)
  process.exit(1)
}
console.log('PRESET ROW PROBE OK —— 本包每一行都能按自己的 inject 声明挂载')
