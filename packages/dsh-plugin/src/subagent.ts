/**
 * 子代理委派请求的**契约镜像**：一处声明，四处共用。
 *
 * ## 为什么要单独一个模块（2026-09-17 事故，E31）
 *
 * 此前四个工具文件各自抄了一份：
 *
 *     interface SubagentLike {
 *       start(name: string, request: unknown): Promise<...>   // ← request 是 unknown
 *     }
 *
 * `request: unknown` 意味着**这次调用没有任何一个字段被类型检查**。于是
 * `SubagentStartRequest` 里那个**必填**的 `signal` 被漏掉了，而 `tsc` 全绿。
 *
 * 真宿主里的后果（用户实测，`cvagent_kb_scout` 连续失败 3 次）：
 *
 *     Error: Cannot read properties of undefined (reading 'aborted')
 *
 * 抛出点是 `@deepseek-ai/dsh-subagent-in-process-driver`：
 *
 *     async function startInProcessRun(request, options) {
 *       if (request.signal.aborted) throw prePublicationAbort()   // lib/index.js:163
 *
 * 该文件自己的文档写着「@param request - the trusted typed start request,
 * **including its required signal**」——契约是明确的，只是我们的镜像把它抹掉了。
 *
 * ## 为什么不能直接 import 真类型
 *
 * `@deepseek-ai/dsh-subagent` 不在本包的依赖里（本包只装 cordis / dsh-tools /
 * dsh-system-prompt / dsh-credentials / schemastery）。因此这里**照抄必填字段**，
 * 并由 `tests/subagent-contract.test.ts` 对着**已安装的** `types.d.ts` 做漂移检查：
 * 真类型的每个必填字段，本文件都必须有同名必填字段。
 *
 * **字段快照**（`@deepseek-ai/dsh-subagent` 0.1.5-rc.2，`lib/types/types.d.ts:136`）：
 * 必填 = `prompt` / `parent` / `signal`；可选 = `label` / `agentOptions` /
 * `outputSchema` / `maxDepth` / `toolFilter` / `persona`。
 *
 * @module cv-agent-dsh/subagent
 */

/** 我们实际构造的 prompt 只用到文本块（真类型是 `ContentBlock[]`）。 */
export interface SubagentPromptBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * 一次 one-shot 子代理启动请求。
 *
 * ⚠️ `signal` 是**必填**，不是可选：委派的取消通道就是它——子代理发布前
 * provider 会据此清理并拒绝，发布后据此取消剩余回合。漏传的报错形态极不友好
 * （`reading 'aborted'`），因为抛出点在 provider 内部的第一行解引用。
 * 传 `exec.signal`（`ToolExecution.signal`，dsh-tools 里同样是必填）。
 */
export interface SubagentStartRequest {
  /** 作为子代理用户消息投递的内容。 */
  readonly prompt: readonly SubagentPromptBlock[]
  /** 发起委派的父 agent（`exec.agent`）。 */
  readonly parent: unknown
  /** 调用方的取消通道（`exec.signal`）。**必填**。 */
  readonly signal: AbortSignal
  /** 会话里显示的短标签。 */
  readonly label?: string
  /** 子代理工具白名单。未知工具名会被响亮拒绝（E14）。 */
  readonly toolFilter?: unknown
  /** 子代理人设（覆盖部署级 persona）。 */
  readonly persona?: string
  /** 结构化输出契约；给了就必须按契约应答。 */
  readonly outputSchema?: unknown
  /** 委派深度上限；0 表示子代理不能再委派。 */
  readonly maxDepth?: number
}

export interface SubagentResultLike {
  readonly structured?: unknown
  readonly stopReason: string
  readonly diagnostic?: string
}

export interface SubagentRunLike {
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

/** `ctx.get('subagents')` 的最小视图；只声明我们用到的面。 */
export interface SubagentLike {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRunLike>
}
