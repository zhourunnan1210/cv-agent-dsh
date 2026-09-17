/**
 * 行模块的 `inject` 声明检查（一次真故障的防回归）。
 *
 * ## 事故经过（2026-09-17）
 *
 * 会话里切换 preset 直接失败：
 *
 *     无法切换到「CV Research Orchestrator」：
 *     failed to apply loader entry cvagent-instructions (cv-agent-dsh/instructions):
 *     cannot get property "systemPrompt" without inject
 *
 * 原因：那一行的 `apply` 访问 `ctx.systemPrompt`，却没有 `inject: ['systemPrompt']`。
 * Cordis 要求**按属性访问服务前先声明依赖**，否则抛错——而这个错误在**切换 preset**
 * 时才发生，界面上表现为"整个 preset 坏了"，不是"某行漏了声明"（E19 同类爆炸半径）。
 *
 * ## 为什么原测试没抓到
 *
 * `tests/instructions.test.ts` 把行模块的 `default` 直接塞进一个**自己写了 inject 的
 * 外层 plugin** 里调用——于是依赖由测试补齐，**行模块自己的 inject 从未被检查**。
 * 教训：测一个"插件声明"时，必须让它以**自己的声明**去挂载。
 *
 * ## 本测试做什么
 *
 * 静态扫描 `src/**\/*.ts` 里的行模块（有顶层 `apply` 的模块）：
 * 1. 取出它声明的依赖（命名 `inject` 导出，或 `static inject = [...]`）；
 * 2. 扫出 body 里按属性访问的服务（`ctx.<service>` / `this.ctx.<service>`）；
 * 3. 断言每个被访问的服务都在声明里（`ctx.get('x')` 形式的可选依赖除外）。
 *
 * 它是启发式（静态文本），但抓的正是"漏声明 → 整份挂载失败"这一类高代价错误；
 * 误报可以通过 SERVICES 白名单或 `ctx.get()` 写法消除。
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
const REPO_SRC_ROOT = join(SRC, '..')

/**
 * 会被"按属性访问"的服务名单（宿主 + 本插件发布的服务）。
 * 只列我们真实用到的：漏列会漏检，多列会误报——所以保持小而准。
 */
const SERVICES = [
  'systemPrompt',
  'tools',
  'kb',
  'projectState',
  'ideaScore',
  'agents',
  'subagents',
  'skills',
  'commands',
  'session',
  'fs',
]

async function listSourceFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'lib', 'dist'].includes(entry.name)) continue
      await listSourceFiles(full, found)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full)
    }
  }
  return found
}

/**
 * 去掉注释后再扫。
 *
 * 不这么做会误报：`state/service.ts` 的**文档注释**里提到 `ctx.tools`（解释"与
 * `@deepseek-ai/dsh-tools` 对 ctx.tools 的扩展同模式"），代码里从未访问它。
 * 启发式扫描要抓代码，就必须先把注释剥掉。
 *
 * 行注释用 `(?<!:)\/\/` —— 避免把 `https://…` 这类 URL 的后半行误当注释吃掉。
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
}

/** 取出模块声明的依赖：命名 `inject` 导出、`static inject`、或 plugin 对象里的 inject 字面量。 */
function declaredInject(text) {
  const declared = new Set()
  const named = /export const inject\s*(?::[^=]+)?=\s*\[([^\]]*)\]/.exec(text)
  if (named !== null) {
    for (const item of named[1].matchAll(/'([^']+)'|"([^"]+)"/g)) declared.add(item[1] ?? item[2])
  }
  const statics = /static\s+inject\s*(?::[^=]+)?=\s*\[([^\]]*)\]/g
  for (const match of text.matchAll(statics)) {
    for (const item of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) declared.add(item[1] ?? item[2])
  }
  // plugin 对象里的 inject: ['x'] （如 state/orchestrator-guard 的返回值）
  for (const match of text.matchAll(/\binject:\s*\[([^\]]*)\]/g)) {
    for (const item of match[1].matchAll(/'([^']+)'|"([^"]+)"/g)) declared.add(item[1] ?? item[2])
  }
  return declared
}

/** 扫出按属性访问的服务（排除 `ctx.get('x')` 这种显式可选依赖）。 */
function accessedServices(text) {
  const accessed = new Map()
  for (const service of SERVICES) {
    const patterns = [
      new RegExp(`\\bctx\\.${service}\\b`, 'g'), // 功能型 apply(ctx)
      new RegExp(`\\bthis\\.ctx\\.${service}\\b`, 'g'), // 服务类
    ]
    let count = 0
    for (const pattern of patterns) count += [...text.matchAll(pattern)].length
    if (count > 0) accessed.set(service, count)
  }
  return accessed
}

describe('行模块的 inject 声明（漏声明 = 整份 preset 挂载失败）', () => {
  it('每个按属性访问服务的模块都必须声明该服务', async () => {
    const files = await listSourceFiles(SRC)
    const offenders = []
    let checked = 0

    for (const file of files) {
      const text = await readFile(file, 'utf8')
      const code = stripComments(text)
      const accessed = accessedServices(code)
      if (accessed.size === 0) continue
      // 只检查"行模块/服务类"：有顶层 apply 或 class extends Service
      const isRowModule = /export function apply\(|export default apply|class \w+ extends Service/.test(code)
      if (!isRowModule) continue
      checked += 1

      const declared = declaredInject(text)
      // 服务类内部通过 this.ctx.get('kb') 取可选依赖是合法写法，已被 accessedServices 排除
      for (const service of accessed.keys()) {
        if (!declared.has(service)) {
          offenders.push(`${relative(REPO_SRC_ROOT, file)}：访问 ctx.${service}（${accessed.get(service)} 处）但 inject 未声明它（已声明：${[...declared].join(',') || '无'}）`)
        }
      }
    }

    expect(checked, '没有扫到任何行模块：SRC 路径或判定条件写错了').toBeGreaterThan(4)
    expect(offenders, `以下模块会在宿主装载时抛 "cannot get property ... without inject"：\n${offenders.join('\n')}`).toEqual([])
  })

  it('instructions 行：声明了 systemPrompt（事故的直接回归）', async () => {
    const text = await readFile(join(SRC, 'instructions.ts'), 'utf8')
    expect(declaredInject(text).has('systemPrompt')).toBe(true)
    expect(accessedServices(text).has('systemPrompt')).toBe(true)
  })

  it('工具行：都声明了 tools（否则 register 拿不到运行时）', async () => {
    const toolsRows = ['state/tools.ts', 'kb/tools.ts', 'kb/extract-tool.ts', 'kb/entry-tools.ts', 'kb/research-tools.ts', 'scoring/tools.ts', 'domain/tools.ts', 'writing/tools.ts']
    for (const row of toolsRows) {
      const text = await readFile(join(SRC, row), 'utf8')
      expect(declaredInject(text).has('tools'), `${row} 未声明 tools`).toBe(true)
    }
  })
})
