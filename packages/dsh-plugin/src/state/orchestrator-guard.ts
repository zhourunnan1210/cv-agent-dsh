/**
 * 主编排会话的执行级工具护栏（E20 的落地）。
 *
 * ## 为什么是执行级而不是目录级
 *
 * E20 调查结论（L2 源码级）：主 Agent 的工具面**目录级**限制在 dsh 当前版本
 * 没有受支持的扩展点——`restrict()` 必须发生在 agent 自身的 scoped ctx 上，
 * 而那个窗口（agent factory 的 `setup(agentCtx)`）由
 * `dsh-api-session-controller.composeAgent()` 硬编码：
 *
 * ```js
 * setup: async (agentCtx, agent) => {
 *   this.installSelection(agent);
 *   await presets.mount(agentCtx, resolvedId);   // 唯一的挂载点，无第三方钩子
 * }
 * ```
 *
 * 因此本行改用**执行级护栏**：监听 `tools/pre-execute` waterfall，对
 * **根 agent**（主会话，非子代理）拦截重上下文工具。被拦截的调用返回
 * `deny` 决策——模型看到的是可读的拒绝理由，而不是一次真的全文读取。
 *
 * 语义边界（诚实声明）：
 * - 护栏让主 Agent **看不到结果**，但工具名仍出现在目录里。目录级隐藏
 *   需要 dsh 提供 agent setup 的扩展点（或改 controller），不在本插件能力内。
 * - 对子代理无效：只有 `agents.roots()` 里的根 agent 被拦截；委派的子代理
 *   由其 `toolFilter` 白名单约束（S1 已实证）。
 *
 * ## 落位
 *
 * 本行不提供任何服务（只消费宿主 `tools` 事件与 `agents` 注册表），
 * 因此放在 cv-research preset 的组合里、isolate group **之外**（与 standard
 * 里 tool-fs 等「只消费不提供」的行同规则）。
 *
 * @module cv-agent-dsh/orchestrator-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { ORCHESTRATOR_DENY_TOOLS } from '../tools/names.js'

/** 插件配置。 */
export interface Config {
  /** 对根 agent 禁用的工具名列表；缺省为 ORCHESTRATOR_DENY_TOOLS。 */
  denyForRoot?: string[]
}

export const Config = Schema.object({
  denyForRoot: Schema.array(Schema.string()).default([...ORCHESTRATOR_DENY_TOOLS]).description('对根 agent（主会话）禁用的工具名列表。'),
})

export const name = 'cvagent-orchestrator-guard'
export const inject = ['tools']

/**
 * 执行级护栏。E19 教训：默认值显式落定，不依赖 schemastery。
 *
 * @param ctx - 本行的 cordis 上下文（注入 tools）。
 * @param config - 行配置；preset 组合里不带 config 时 Loader 传入 undefined。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const deny: ReadonlySet<string> = new Set(config.denyForRoot ?? ORCHESTRATOR_DENY_TOOLS)
  const agents = ctx.get('agents') as { roots?: () => readonly { id: unknown }[] } | undefined

  /** 调用方是否为根 agent（主会话）；agents 缺失时护栏不生效（fail-open）。 */
  const isRootAgent = (agent: { id: unknown } | undefined): boolean => {
    if (agent === undefined || agents === undefined || typeof agents.roots !== 'function') return false
    return agents.roots().some((root) => root.id === agent.id)
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (deny.has(exec.name) && isRootAgent(exec.agent)) {
      return {
        kind: 'deny',
        reason:
          `cv-research：主编排会话禁用重上下文工具 ${exec.name}（§1.3 原则四）。`
          + '把全文阅读与下载委派给子代理（Scout/Reader），用 toolFilter 按角色白名单收紧；'
          + '如确需主会话直读，请先调整本护栏配置。',
      }
    }
    return next()
  })
}
