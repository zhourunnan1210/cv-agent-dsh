/**
 * 委派深度上限的**真契约测试**（E33 的守卫）。
 *
 * ## 事故
 *
 * 2026-09-17，新课题立项时 `cvagent_kb_scout` 在根会话里直接失败：
 *
 *     Error: subagent depth 1 exceeds maxDepth 0
 *
 * 我们把 `maxDepth` 理解成「子代理还能不能再往下派」（相对语义），写死 `0` 想表达
 * "worker 不许再派孩子"。而 SDK 的语义是**子代理自己的绝对层级上限**：
 *
 *     // @deepseek-ai/dsh-subagent/lib/index.js:432
 *     function resolveChildDepth(parent, maxDepth) {
 *       const childDepth = delegationDepthOf(parent) + 1
 *       if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(...)
 *     }
 *
 * 根会话层级 0 ⇒ 子代理层级 1 ⇒ `1 > 0` ⇒ **任何**委派都失败。写死 `0` 的共 6 处，
 * 覆盖检索 / 提取 / 归纳 / idea 生成 / idea 打分 / 写作——整条委派链路阻断。
 *
 * ## 为什么单测没抓到
 *
 * 四个测试文件都写着 `expect(call.request.maxDepth).toBe(0)`：**把错误取值固化成了期望值**。
 * 断言的只是"我们传了什么"，不是"这个值能不能用"。
 *
 * ## 本测试做什么（关键：不抄判据）
 *
 * 直接 import 已安装的**真 SDK**，构造出满足 `delegationDepthOf` 读取方式的假 parent
 * （它读 `agent.options.subagentDepth` 与 `agent.session.header.delegationDepth`），
 * 然后调用**真的** `resolveChildDepth(parent, maxDepth)`：
 *
 * 1. 断言 `SUBAGENT_MAX_DEPTH` 在根会话、层级 1、层级 2 三种前提下都能通过；
 * 2. 反向断言 `0` 必抛、`1` 在层级 1 的编排者下也抛——**守卫必须先证明它能失败**，
 *    否则它就是一条不会红的假保证（本 session 已经栽过两次：E30 的探针、E31 的探针）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import { SUBAGENT_MAX_DEPTH } from '../lib/subagent.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}

const sdk = await loadDsh('@deepseek-ai/dsh-subagent')

/**
 * 造一个"父 agent"的最小替身，形状对齐真实现 `delegationDepthOf`：
 *
 *     agent.options.subagentDepth
 *     agent.session.header.delegationDepth ?? 0
 *
 * 真的 Agent 造不出来，但**判据函数是真的**——被测的是 `resolveChildDepth`，
 * 不是 `delegationDepthOf` 怎么读字段。
 */
function parentAtDepth(depth) {
  return { options: { subagentDepth: depth }, session: { header: { delegationDepth: depth } } }
}

describe('委派深度上限（写 0 = 任何委派都失败）', () => {
  it('SDK 契约仍在：三个符号都导出，且报错文案与事故记录一致', () => {
    expect(typeof sdk.resolveChildDepth).toBe('function')
    expect(typeof sdk.delegationDepthOf).toBe('function')
    expect(typeof sdk.SubagentDepthError).toBe('function')
    // 假 parent 必须真的被 SDK 读懂，否则下面的断言全是空转
    expect(sdk.delegationDepthOf(parentAtDepth(0))).toBe(0)
    expect(sdk.delegationDepthOf(parentAtDepth(2))).toBe(2)
    expect(new sdk.SubagentDepthError(1, 0).message).toBe('subagent depth 1 exceeds maxDepth 0')
  })

  it('SUBAGENT_MAX_DEPTH 让根会话 / 层级 1 / 层级 2 三种编排前提都能派出子代理', () => {
    for (const depth of [0, 1, 2]) {
      const childDepth = sdk.resolveChildDepth(parentAtDepth(depth), SUBAGENT_MAX_DEPTH)
      expect(childDepth).toBe(depth + 1)
      expect(childDepth).toBeLessThanOrEqual(SUBAGENT_MAX_DEPTH)
    }
  })

  it('反向验证：0 在任何层级都抛；1 在层级 ≥1 的编排者下也抛', () => {
    // 事故取值：根会话下必抛，且报错文案与用户所见逐字一致
    expect(() => sdk.resolveChildDepth(parentAtDepth(0), 0)).toThrow(sdk.SubagentDepthError)
    expect(() => sdk.resolveChildDepth(parentAtDepth(0), 0)).toThrow('subagent depth 1 exceeds maxDepth 0')
    // 0 在任何父层级下都抛：子代理最小也是第 1 层
    for (const depth of [0, 1, 2]) {
      expect(() => sdk.resolveChildDepth(parentAtDepth(depth), 0)).toThrow(sdk.SubagentDepthError)
    }
    // 1 只够"根会话派一层"：编排者自己也是子代理（层级 1）时，worker（第 2 层）就被挡住
    expect(sdk.resolveChildDepth(parentAtDepth(0), 1)).toBe(1)
    expect(() => sdk.resolveChildDepth(parentAtDepth(1), 1)).toThrow(sdk.SubagentDepthError)
  })

  it('常量取值有下限，且与部署自带 subagent 工具的默认值一致', () => {
    expect(Number.isSafeInteger(SUBAGENT_MAX_DEPTH)).toBe(true)
    expect(SUBAGENT_MAX_DEPTH).toBeGreaterThanOrEqual(1)
    // 与 `dsh-tool-subagent` 的 `maxDepth: ...default(3)` 对齐；要改得有意识，不是随手调
    expect(SUBAGENT_MAX_DEPTH).toBe(3)
    // 且必须能通过 SDK 自己的参数校验
    expect(() => sdk.assertSubagentMaxDepth(SUBAGENT_MAX_DEPTH)).not.toThrow()
    expect(() => sdk.assertSubagentMaxDepth(0)).not.toThrow() // 0 是合法参数，只是语义上必然拒绝（这才是坑）
  })
})
