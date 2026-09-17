/**
 * 子代理委派契约的**漂移检查 + 调用点检查**（E31 的守卫）。
 *
 * ## 事故
 *
 * 用户在真实会话里连续 3 次 `cvagent_kb_scout` 失败：
 *
 *     Error: Cannot read properties of undefined (reading 'aborted')
 *
 * 真宿主 `@deepseek-ai/dsh-subagent-in-process-driver` 的第一行就是
 * `if (request.signal.aborted) throw prePublicationAbort()`，而 `SubagentStartRequest.signal`
 * 是**必填**字段（其 jsdoc：「Cancellation signal from the spawning context (the tool's
 * `exec.signal`)」）。我们漏传了它。
 *
 * **为什么 `tsc` 没拦住**：四个工具文件各自抄了一份
 *
 *     interface SubagentLike { start(name: string, request: unknown): ... }
 *
 * `request: unknown` 让这次调用的**每一个字段**都逃过了类型检查——又一次"自己重写了
 * 对方的契约，于是没人能检查它"（本次 session 的第三次同族事故：见 E30 的 inject、
 * `instructions.test.ts` 的替声明）。
 *
 * ## 本测试的两道检查
 *
 * 1. **漂移检查**：直接读**已安装的** `@deepseek-ai/dsh-subagent/lib/types/types.d.ts`，
 *    解析出 `SubagentStartRequest` 的必填字段集合，要求 `src/subagent.ts` 里的同名接口
 *    把每个必填字段都声明为必填。将来宿主给这个接口加必填字段，这里会红。
 * 2. **调用点检查**：扫 `src/**\/*.ts` 里每个 `subagents.start(` 调用，其对象字面量必须
 *    显式给出 `signal:`。漏传会在运行时炸成 `reading 'aborted'`，静态拦住它便宜得多。
 */
import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
const REPO_SRC_ROOT = join(SRC, '..')

/** 已安装的 dsh 装载位置：与其它测试一样，从部署根解析。 */
const DSH_ROOT = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
const REAL_TYPES = join(
  DSH_ROOT,
  'node_modules/@deepseek-ai/dsh-subagent/lib/types/types.d.ts',
)

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

/** 从一段 `interface X { ... }` 文本里取出字段名 → 是否必填（含 `?` 即可选）。 */
function fieldsOf(body) {
  const fields = new Map()
  for (const match of body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:/gm)) {
    fields.set(match[1], match[2] !== '?')
  }
  return fields
}

/** 抽出某个 interface 的完整 body（按花括号配对，容忍嵌套对象类型）。 */
function interfaceBody(text, name) {
  const start = new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).exec(text)
  if (start === null) return undefined
  let depth = 0
  let index = start.index + start[0].length - 1
  const from = index + 1
  for (; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(from, index)
    }
  }
  return undefined
}

describe('子代理委派契约（漏 signal = 运行期炸 reading "aborted"）', () => {
  it('本地镜像声明了真接口的每一个必填字段', async () => {
    const real = await readFile(REAL_TYPES, 'utf8')
    const realBody = interfaceBody(real, 'SubagentStartRequest')
    expect(realBody, `没在 ${REAL_TYPES} 里找到 SubagentStartRequest`).toBeTruthy()

    const local = await readFile(join(SRC, 'subagent.ts'), 'utf8')
    const localBody = interfaceBody(local, 'SubagentStartRequest')
    expect(localBody, 'src/subagent.ts 里没有 SubagentStartRequest').toBeTruthy()

    const realFields = fieldsOf(realBody)
    const localFields = fieldsOf(localBody)

    const missing = []
    for (const [field, required] of realFields) {
      if (!required) continue
      if (!localFields.has(field)) missing.push(`${field}（真接口必填，本地镜像没有）`)
      else if (localFields.get(field) === false) missing.push(`${field}（真接口必填，本地镜像写成了可选）`)
    }
    expect(
      missing,
      `本地镜像与已安装的 dsh-subagent 契约漂移：\n${missing.join('\n')}`
      + '\n（真接口路径：' + REAL_TYPES + '）',
    ).toEqual([])

    // 反向：真接口里确实有 signal 且必填（这条本身就是事故的回归断言）
    expect(realFields.get('signal'), '真接口的 signal 不再是必填？契约变了，需重新确认').toBe(true)
    expect(localFields.get('signal')).toBe(true)
  })

  it('每个 subagents.start 调用点都显式传了 signal', async () => {
    const files = await listSourceFiles(SRC)
    const offenders = []
    let callSites = 0

    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/\.start\(\s*'spawn'\s*,\s*\{/g)) {
        callSites += 1
        // 取到与 `{` 配对的对象字面量
        let depth = 0
        let index = match.index + match[0].length - 1
        const from = index + 1
        let body
        for (; index < text.length; index += 1) {
          if (text[index] === '{') depth += 1
          else if (text[index] === '}') {
            depth -= 1
            if (depth === 0) { body = text.slice(from, index); break }
          }
        }
        if (body === undefined || !/^\s*signal\s*:/m.test(body)) {
          const line = text.slice(0, match.index).split('\n').length
          offenders.push(`${relative(REPO_SRC_ROOT, file)}:${line}`)
        }
      }
    }

    expect(callSites, '没扫到任何委派调用点：判定条件写错了').toBeGreaterThan(3)
    expect(
      offenders,
      `以下委派调用点没传 signal（运行期会抛 reading 'aborted'）：\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('委派调用点的 request 不再是 unknown（否则字段检查全被抹掉）', async () => {
    const files = await listSourceFiles(SRC)
    const offenders = []
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      // 先剥注释：`src/subagent.ts` 的文档注释里**引用**了这段坏模式当作反面教材，
      // 不剥就会把它自己判成违规（与 tests/row-inject.test.ts 同一个坑）。
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '')
      if (/start\(name: string, request: unknown\)/.test(code)) {
        offenders.push(relative(REPO_SRC_ROOT, file))
      }
    }
    expect(
      offenders,
      '这些文件又抄了一份 request: unknown 的 SubagentLike —— 请从 src/subagent.ts 导入：\n'
      + offenders.join('\n'),
    ).toEqual([])
  })

  /**
   * E33：`maxDepth` 是**子代理的绝对层级上限**，写死小数字会让委派系统性失败。
   *
   * 这条静态扫**全部**调用点（不止有请求形状断言的 4 个工具），把字面量 0 挡在源码层；
   * 语义侧的判据由 `tests/subagent-depth.test.ts` 调真 SDK 的 `resolveChildDepth` 校验。
   */
  it('委派调用点的 maxDepth 不许是字面量 0（写死即整条链路阻断）', async () => {
    const files = await listSourceFiles(SRC)
    const offenders = []
    let sites = 0
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const match of text.matchAll(/maxDepth:\s*([^,\n]+),/g)) {
        sites += 1
        const value = match[1].trim()
        const line = text.slice(0, match.index).split('\n').length
        // 数字字面量必须 ≥ 1：子代理最小也是第 1 层（详见 src/subagent.ts 的 SUBAGENT_MAX_DEPTH）
        if (/^\d+$/.test(value) && Number(value) < 1) {
          offenders.push(`${relative(REPO_SRC_ROOT, file)}:${line}  maxDepth: ${value}`)
        }
      }
    }
    expect(sites, '没扫到任何 maxDepth 调用点：判定条件写错了').toBeGreaterThanOrEqual(6)
    expect(
      offenders,
      'maxDepth 写死为 0 会让**任何**委派都抛 "subagent depth 1 exceeds maxDepth 0"（E33）：\n'
      + offenders.join('\n'),
    ).toEqual([])
  })
})
