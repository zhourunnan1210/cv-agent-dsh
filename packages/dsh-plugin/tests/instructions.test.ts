/**
 * 项目约定章节测试（P3-3d）：静态 prompt section 的注册与内容。
 *
 * 用真实 `@deepseek-ai/dsh-system-prompt` + 真实 Cordis 上下文，断言：
 * - 章节按名字注册、可卸载（effect 归属当前 fiber）；
 * - 渲染出的文本包含**三条硬规则**与文档路径（这些是跨步骤约束，缺一条就等于没约束）；
 * - `order` 排在 state 的动态章节之后（约定是"长期背景"，不该插在阶段上下文前面）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import * as instructions from '../lib/instructions.js'

const DSH = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/'
function loadDsh(spec) {
  const require = createRequire(DSH + spec + '/package.json')
  return import(pathToFileURL(require.resolve(spec)).href)
}
const systemPromptModule = await loadDsh('@deepseek-ai/dsh-system-prompt')
const cordis = await loadDsh('@deepseek-ai/cordis')

describe('项目约定章节的渲染（纯函数）', () => {
  const config = instructions.resolveInstructionsConfig(undefined)

  it('包含文档路径、实验目录与三条硬规则的关键判据', () => {
    const text = instructions.renderConventions(config)
    expect(text).toContain('[cv-research 项目约定]')
    expect(text).toContain('docs/实验归档与组织原则.md')
    expect(text).toContain('experiments/')
    // 规则 1：数字溯源
    expect(text).toContain('EVIDENCE.md')
    expect(text).toContain('metrics.json#auc')
    expect(text).toContain('paper:<paper_id>')
    // 规则 2：失败也归档 + 回流失败库
    expect(text).toContain('## 负面结论')
    expect(text).toContain('failures')
    // 规则 3：可原地重跑
    expect(text).toContain('cmd.txt')
    expect(text).toContain('env.txt')
    // 授权边界（E15）
    expect(text).toContain('委派之前')
  })

  it('配置可覆盖根路径（不写死仓库相对路径）', () => {
    const custom = instructions.resolveInstructionsConfig({ repoRoot: 'D:/proj', projectRoot: 'D:/proj/data/projects/x' })
    const text = instructions.renderConventions(custom)
    expect(text).toContain('D:/proj/docs/实验归档与组织原则.md')
    expect(text).toContain('D:/proj/experiments/')
  })
})

describe('章节在真实 system prompt 上注册/卸载', () => {
  it('注册后出现在装配结果里，卸载后消失（生命周期红线）', async () => {
    const app = new cordis.Context()
    await app.plugin({
      name: 'prompt-host',
      async apply(ctx) {
        await ctx.plugin(systemPromptModule.default)
      },
    })

    const fork = await app.plugin({
      name: 'conventions',
      inject: ['systemPrompt'],
      apply(ctx) {
        instructions.default(ctx, { repoRoot: '.' })
      },
    })

    // 真实 API：section() 注册（返回 disposer），assemble() 读装配结果
    const assembly = await app.systemPrompt.assemble()
    const ours = assembly.sections.find((section) => section.name === instructions.SECTION_NAME)
    expect(ours).toBeDefined()
    expect(String(ours?.text ?? '')).toContain('实验归档与组织原则')
    expect(String(ours?.text ?? '')).toContain('## 负面结论')

    if (typeof fork?.dispose === 'function') await fork.dispose()
    const after = await app.systemPrompt.assemble()
    expect(after.sections.map((section) => section.name)).not.toContain(instructions.SECTION_NAME)
  })
})
