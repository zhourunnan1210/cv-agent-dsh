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

/** 默认导出：loader 取 `module.default`（E18-②：只有命名导出会被拒）。 */
export default apply
