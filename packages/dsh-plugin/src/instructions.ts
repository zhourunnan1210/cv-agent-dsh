/**
 * 项目约定章节（静态 prompt section）：把「实验归档与组织原则」的入口与硬规则
 * 常驻在 Orchestrator 的上下文里。
 *
 * 为什么要常驻而不是按需读文件：实验阶段的产物要求是**跨步骤**的约束
 * （建目录时要有 README 的成功判据、跑完要有 metrics.json、收敛要写 RESULTS/EVIDENCE），
 * 等到 agent 想起来去读文档时通常已经漏了。这里只放**入口 + 三条硬规则 + 校验命令**，
 * 细则留给 `docs/实验归档与组织原则.md`——避免把长文档灌进每一步的 prompt。
 *
 * 与 state 服务的动态章节（order 125）分工：那个给「当前阶段/模式/门控」，
 * 这个给「长期约定」。order 取 130，紧随其后。
 *
 * @module cv-agent-dsh/instructions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'cvagent-instructions'

/** 章节名（审计与测试用）。 */
export const SECTION_NAME = 'cvagent:conventions'

/**
 * 声明依赖的服务。
 *
 * ⚠️ **必须声明，否则整份 preset 挂载失败**（2026-09-17 实测的真故障）：
 * `apply` 里访问 `ctx.systemPrompt`，而 Cordis 要求按属性访问服务前先在 `inject` 里
 * 声明，否则抛 `cannot get property "systemPrompt" without inject`。这个错误发生在
 * **切换 preset 时**，用户看到的是「无法切换到 CV Research Orchestrator」，
 * 而不是"某一行漏了 inject"——与 E19 同类的爆炸半径。
 *
 * ⚠️⚠️ **而且这份声明必须落在 loader 真正读的那一侧**（同一次事故的第二层根因，2026-09-17 二次实测）：
 * loader 装载每一行时都走 `cordis-plugin-loader` 的
 *
 *     plugin = unwrapExports(module)   // = module.default ?? module
 *
 * ——**模块一旦有 `default` 导出，命名导出的 `inject` 就被整个丢掉**。本文件原来写着
 * `export default apply`（一个普通函数），于是 loader 拿到的插件是那个**函数**，
 * 函数上没有 inject：`export const inject` 形同不存在，加了也照样抛同一个错。
 *
 * 现在的形态与 8 个工具行一致：**只导出命名 `apply` / `inject` / `name`、不写 default**，
 * loader 解包后拿到的是模块命名空间对象，命名 `inject` 才会被读到。
 * （3 个服务行走的是第三条路：`default` 是类，读 `static inject`。）
 * `scripts/probe-preset-rows.mjs` 按同一条解包规则逐行试挂，`tests/row-inject.test.ts`
 * 静态守住同一条规则——两者都不会再"替这一行补上它自己没写的声明"。
 */
export const inject = ['systemPrompt']

/**
 * 默认的项目根：与 projectState 的 projectDir 默认值同源（`data/projects/default`）。
 * 实验目录据此拼出绝对路径提示，避免 agent 在错误的 cwd 下找 `experiments/`。
 */
export interface Config {
  readonly projectRoot?: string
  /** 仓库根（放 docs/ 与 scripts/ 的地方）。 */
  readonly repoRoot?: string
}

export function resolveInstructionsConfig(config: Config | undefined): Required<Config> {
  return {
    projectRoot: config?.projectRoot ?? 'data/projects/default',
    repoRoot: config?.repoRoot ?? '.',
  }
}

/** 渲染章节文本（纯函数，便于测试）。 */
export function renderConventions(config: Required<Config>): string {
  return [
    '[cv-research 项目约定]',
    `实验与归档遵循 ${config.repoRoot}/docs/实验归档与组织原则.md（实验目录：${config.repoRoot}/experiments/）。`,
    '',
    '三条硬规则（不可协商）：',
    '1. 任何数字都要能指回产物：论文/报告里的每个数字都必须在对应实验的 EVIDENCE.md 里有一行，',
    '   来源写到「文件 + 字段」（如 runs/<id>/metrics.json#auc）或 `paper:<paper_id>`。',
    '2. 失败的实验同样归档：照常建目录、照常写 RESULTS.md 并在末尾写 `## 负面结论`，',
    '   写明失败模式与「什么条件下值得再试」——负结论要回流失败方法库（failures）。',
    '3. 一次运行必须能原地重跑：每个 runs/<id>/ 必须有 cmd.txt（完整命令）、env.txt（版本/硬件）、',
    '   metrics.json（机器可读指标）；随机种子写进 config，不写在代码里。',
    '',
    '实验开始前从 experiments/_template/ 复制一份并登记 experiments/INDEX.md；',
    '实验收敛时跑 `node scripts/check-experiment.mjs experiments/<E00x-slug>` 补齐缺件，',
    '把结果写进 cvagent_state_advance 的阶段摘要。',
    '需要 GPU 实例 / 计费 API / 破坏性操作时，必须在**委派之前**取得用户授权（子代理不能中途发起审批）。',
    '',
    '【怎么跟用户说话】用户是研究者，不是工程师：他要判断「这条 idea 值不值得做」，',
    '而不是读工具输出。所以：',
    '1. 一律用**平实中文**。工具名、字段名、英文缩写只在用户需要自己核对时才出现，',
    '   第一次出现必须跟一句人话解释。不要把 JSON 原样丢给用户。',
    '2. 先给**一句话结论**（"够用了" / "还差一些，缺在这些地方"），再给数字与来源。',
    '3. 提问一律用 ask_user_question，选项写成**人能直接判断的取舍**，不写参数名。',
    '   例：「这批文献看着够用了，你想怎么办？」→ ① 就用现有的，别再找了 '
    + '② 只补最近两年的新论文 ③ 重新找一批。',
    '4. **要不要再检索，由用户定，不由你定**：库里已有相当存量时，先用 cvagent_kb_summary '
    + '与 cvagent_kb_search 抽查本课题关键词的命中情况，再用白话问用户选哪条路；',
    '   用户说"就用现有的"→ 落 cvagent_scope_set(reuse_existing=true)；说"补新的"→ 正常走检索。',
  ].join('\n')
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveInstructionsConfig(config)
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: 130,
    text: () => renderConventions(resolved),
  })
}

// ⚠️ **不要在这里加 `export default apply`**（2026-09-17 事故的第二层根因）。
//
// 加了它，loader 的 `unwrapExports`（= `module.default ?? module`）就会把插件解析成
// 这个**函数**，于是上面那份命名 `inject` 被丢弃，`apply` 里访问 `ctx.systemPrompt`
// 立刻抛 `cannot get property "systemPrompt" without inject`，**整份 preset 挂载失败**。
// 本文件此前的 `export default apply` 正是这么把一个"看起来已经声明好了"的行变成炸弹的。
//
// E18-② 的原话是"必须有 `default`（插件类）**或**命名 `apply` 导出"——
// 它说的是"两者之一即可被装载"，没说"两种形态下 inject 的读取位置相同"。
// 命名导出形态下，inject 必须也只能挂在命名导出上，且**不能同时存在 default**。
// 与 8 个工具行保持同形；回归由 scripts/probe-preset-rows.mjs 与
// tests/row-inject.test.ts 双向守住。
