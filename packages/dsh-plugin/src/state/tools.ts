/**
 * 状态与门控族工具（v1.2 §15.1 的落地，名字来自 `tools/names.ts` 契约）。
 *
 * 本行是 `projectState` 服务的**消费者**，因此组合文件里必须与
 * `cv-agent-dsh/state` 同处一个 `isolate: { projectState: true }` 的 group。
 *
 * 五个工具全部走真实 `ToolRuntime` 注册与执行管线：
 * 参数校验、output schema 校验、失败结果的 `isError` 形状都由 dsh 保证，
 * 模型看到的是「哪个参数不合法」或「为什么没推进」，而不是堆栈。
 *
 * @module cv-agent-dsh/state-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'

import { STATE_TOOLS } from '../tools/names.js'
import type { ProjectStateService } from './service.js'

export const name = 'cvagent-state-tools'
export const inject = ['projectState', 'tools']

/** 统一渲染：模型与用户都读规范 JSON。 */
function renderJson(_args: unknown, value: unknown) {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function apply(ctx: Context): void {
  // inject 声明了 projectState，运行时必然就绪；类型由 service.ts 的
  // `declare module '@deepseek-ai/cordis'` 扩展保证。
  const service: ProjectStateService = ctx.projectState
  // E17（L1 实测三次失败后定位）：必须保留 `toolsRuntime.register(...)`
  // 的方法调用形态。解构 `const { register } = ctx.tools` 会丢失 this 绑定，
  // 运行时 `this.layers` 未定义。
  const toolsRuntime = ctx.tools

  toolsRuntime.register(defineTool({
    name: STATE_TOOLS.get,
    description: '读取 cv-research 项目状态（project_state.json）：当前阶段、ABC 模式、待决门控、回滚点与历史决议。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exists: { type: 'boolean', required: true, description: '状态文件是否存在' },
          state: { type: 'object', additionalProperties: true, description: '完整项目状态；状态不存在时省略该字段' },
        },
      },
      render: renderJson,
    },
    async execute() {
      const state = await service.getState()
      if (state === undefined) return { exists: false }
      // 工具结果必须是 lossless JSON；显式往返同时满足 InferValue 的
      // Record<string, JsonValue> 约束，并保证结果里没有任何活引用。
      return { exists: true, state: JSON.parse(JSON.stringify(state)) }
    },
  }))

  toolsRuntime.register(defineTool({
    name: STATE_TOOLS.advance,
    description:
      '请求推进当前阶段（三段式门控第 ① 步）：记录阶段完成摘要并校验完成判据。'
      + '达标则写入待决门控——A 模式先经 ask_user_question 询问用户，B/C 模式可直接调用 cvagent_gate_resolve；'
      + '未达标返回缺失项清单。',
    parameters: {
      summary: { type: 'string', required: true, description: '本阶段完成情况摘要（Phase 1 判据：非空摘要即完成）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stage: { type: 'string', required: true, description: '判定的阶段' },
          satisfied: { type: 'boolean', required: true, description: '完成判据是否全部满足' },
          missing: { type: 'array', items: { type: 'string' }, required: true, description: '未满足的判据清单' },
          gate_requested: { type: 'boolean', required: true, description: '是否已写入待决门控（true 表示等待决议）' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const decision = await service.requestStageGate(String(args.summary))
      const state = await service.getOrCreateState()
      return {
        stage: state.current_stage,
        satisfied: decision.satisfied,
        missing: [...decision.missing],
        gate_requested: decision.gate !== null,
      }
    },
  }))

  toolsRuntime.register(defineTool({
    name: STATE_TOOLS.rollback,
    description: '回滚到某个阶段快照点，恢复状态文件（可用回滚点见 cvagent_state_get 的 rollback_points）。',
    parameters: {
      point: { type: 'string', required: true, description: '快照点标识，如 after_knowledge_building' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          restored_stage: { type: 'string', required: true, description: '回滚后所处阶段' },
          rollback_points: { type: 'array', items: { type: 'string' }, required: true, description: '回滚后仍可用的回滚点' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const state = await service.rollback(String(args.point))
      return { restored_stage: state.current_stage, rollback_points: [...state.rollback_points] }
    },
  }))

  toolsRuntime.register(defineTool({
    name: STATE_TOOLS.modeSet,
    description:
      '设定或切换 ABC 模式并落盘：A confirm（每阶段需用户确认）、B supervised（自动流转可回退）、'
      + 'C full_auto（全自动，需预算护栏）。项目尚无状态文件时会把模式写入新建的初始状态。',
    parameters: {
      mode: {
        type: 'string',
        required: true,
        enum: ['confirm', 'supervised', 'full_auto'],
        description: '目标模式',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true, description: '生效后的模式' },
          current_stage: { type: 'string', required: true, description: '当前阶段' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const mode = String(args.mode) as 'confirm' | 'supervised' | 'full_auto'
      const state = await service.setMode(mode)
      // setMode 校验并写入后，state.mode 必然等于 args.mode。
      return { mode, current_stage: state.current_stage }
    },
  }))

  toolsRuntime.register(defineTool({
    name: STATE_TOOLS.gateResolve,
    description:
      '落盘门控决议（三段式门控第 ③ 步）：advance 推进到下一阶段并生成回滚快照；'
      + 'revise 打回当前阶段继续细化；rollback 留痕不推进（随后用 cvagent_state_rollback 选快照点）。'
      + '没有待决门控时会失败——不会静默推进。',
    parameters: {
      decision: {
        type: 'string',
        required: true,
        enum: ['advance', 'revise', 'rollback'],
        description: '决议：advance / revise / rollback',
      },
      comment: { type: 'string', description: '决议说明（留痕审计用）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          advanced: { type: 'boolean', required: true, description: '是否实际推进了阶段' },
          current_stage: { type: 'string', required: true, description: '决议后所处阶段' },
          resolution: { type: 'object', additionalProperties: true, description: '完整决议记录（含阶段、决议、时间戳、是否推进）' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const result = await service.resolveStageGate(
        String(args.decision),
        args.comment === undefined ? undefined : String(args.comment),
      )
      return {
        advanced: result.advanced,
        current_stage: result.current_stage,
        resolution: JSON.parse(JSON.stringify(result.resolution)),
      }
    },
  }))
}
