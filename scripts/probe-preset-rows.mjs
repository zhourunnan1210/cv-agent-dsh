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

/**
 * loader 的导出解包规则 —— **必须是这一份，不能自己另写一套**。
 *
 * `cordis-plugin-loader` 的 `ModuleLoader.unwrapExports`（lib/index.js:745）：
 *
 *     unwrapExports(exports) {
 *       if (isNullable(exports)) return exports
 *       exports = exports.default ?? exports      // ← default 存在就**只认 default**
 *       if (!exports.__esModule) return exports
 *       return exports.default ?? exports
 *     }
 *
 * 而每个 loader entry 装载时都走它（`Entry._init` / `Entry.update`：
 * `plugin = this.loader.unwrapExports(await this.tree.import(...))`）。
 *
 * 后果：**模块一旦有 `default` 导出，命名导出的 `inject` 就被丢掉**。
 * 所以"声明写在哪"是有区别的：
 *   - 只有命名 `apply`（本包 8 个工具行）→ 插件是命名空间对象 → 读得到命名 `inject`；
 *   - `default` 是服务类（本包 3 个服务行）→ 读 `static inject`；
 *   - `default` 是**普通函数**（`instructions.ts`）→ 插件就是这个函数，
 *     函数上没有 inject → 抛 `cannot get property ... without inject`，
 *     **而旁边那个 `export const inject` 完全不起作用**。
 *
 * 本探针第一版是从命名导出取 inject、再手动塞给插件——又一次"守卫替被测对象
 * 承担了责任"，于是这个真 bug 在探针里隐形。现在原样复刻上面这条规则。
 */
function unwrapExports(exports) {
  if (exports === null || exports === undefined) return exports
  const unwrapped = exports.default ?? exports
  if (!unwrapped.__esModule) return unwrapped
  return unwrapped.default ?? unwrapped
}

/** 报告用：这一行的 inject 最终从哪个对象上被读到。 */
function effectiveInject(plugin) {
  return Array.isArray(plugin?.inject) ? [...plugin.inject] : []
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

  // 原样走 loader 的解包规则：**不自己补 inject**（补了就等于替被测对象负责）。
  const plugin = unwrapExports(mod)
  if (plugin === undefined || (typeof plugin.apply !== 'function' && typeof plugin !== 'function')) {
    failures.push({
      row: label,
      stage: 'export',
      message: '解包后既不是函数也没有 apply（E18-②：loader 取 default 或命名 apply，都没有就装不上）',
    })
    console.log(`✗ ${label}\n    阶段=export：解包后没有可用的 apply`)
    continue
  }
  const injectList = effectiveInject(plugin)

  const app = new cordis.Context()
  // ⚠️ 服务必须由一个**宿主行**（root 的子 fiber）发布，不能用 `app.provide` 直接挂在
  // root 上——实测（本文件的历史版本踩过）：
  //   root.provide('systemPrompt') + 行 inject=[]  → **挂载成功**（探针抓不到任何东西）
  //   子 fiber 里 ctx.provide(...)  + 行 inject=[]  → 抛 cannot get property ...
  // 差别就是 Cordis 的依赖检查走的是 fiber 的 store：挂在 root 上的值沿树可见，
  // 绕过了 inject；而生产里 systemPrompt/tools 都由宿主行发布，preset 行是另一棵子树
  // ——正是后一种形状。探针若用前一种，就成了"永远不会失败"的假检查。
  //
  // 桩的名单取 'systemPrompt'/'tools' 与**解包后**那一行的 inject：即"宿主真实提供的东西"。
  // 一行声明了但宿主没提供的服务，会让它停在 waiting（生产里表现为 inactiveRows），
  // 不在这里判失败。
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
