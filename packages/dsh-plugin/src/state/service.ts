/**
 * `projectState` 服务（dsh 侧）。
 *
 * 服务平面归属已裁定（勘误 §4.4.1，2026-09-15 决策记录）：
 *
 * - `projectState` 是**项目私有**状态——同一时刻两个会话可能跑两个课题，
 *   因此必须走 preset + `isolate` realm，**不得**裸放在组合里（会落入进程
 *   全局 realm，第二个会话挂载即冲突），也**不得**放宿主平面（第二个项目
 *   会读到第一个项目的状态）。
 * - 组合文件里，本行与所有消费者（`cv-agent-dsh/state-tools`）必须同处一个
 *   带 `isolate: { projectState: true }` 的 group。
 *
 * ## 分层
 *
 * 状态**语义**（阶段迁移、门控判定、模式差异）在 `@cv-research/core` 的
 * 纯函数里；本服务只负责三件事：把语义落到文件、把文件读回内存、把当前
 * 阶段/模式/待决门控以动态 prompt 章节呈现给模型（勘误 §4.5 的落点——
 * `PromptSection.text` 支持每次组装时求值的函数）。
 *
 * @module cv-agent-dsh/state
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import {
  createProjectState,
  requestGate,
  resolveGate,
  type GateCriteria,
  type GateDecision,
  type Mode,
  type ProjectState,
  type ResolvedGate,
  type Stage,
} from '@cv-research/core'

import { createFileStateStore } from './store.js'
import type { ProjectStateStore } from './store.js'

/** 插件配置；每个部署可变的取值都是带默认值的字段（与 vendored 插件同约定）。 */
export interface Config {
  /** 项目数据目录；`project_state.json` 落在这里。 */
  projectDir?: string
  /** 状态文件名。 */
  stateFilename?: string
  /** 新建项目时写入的 project_id。 */
  projectId?: string
}

export const Config = Schema.object({
  projectDir: Schema.string().default('data/projects/default').description('项目数据目录；project_state.json 与 snapshots/ 落在这里。'),
  stateFilename: Schema.string().default('project_state.json').description('状态文件名。'),
  projectId: Schema.string().default('cv-research-project').description('新建项目时写入的 project_id。'),
})

type ResolvedConfig = Required<Config>

const MODE_LABEL: Readonly<Record<Mode, string>> = {
  confirm: 'A 确认模式（每阶段完成需先经 ask_user_question 取得用户确认，再用 cvagent_gate_resolve 落盘）',
  supervised: 'B 监督模式（自动流转，可随时中止/回退）',
  full_auto: 'C 无人值守模式（全自动流转）',
}

/**
 * Phase 1 的默认完成判据（§9.3 的占位实现）：
 * 当前阶段提供非空摘要即视为完成。
 *
 * 后续按阶段配置化（v1.2 §9.3 的判据表）：知识构建判覆盖率、实验判
 * P0 + Repro 检查清单等。替换时本常量迁移到 Domain Pack / 配置即可，
 * 服务接口不变。
 */
const DEFAULT_CRITERIA: GateCriteria = {
  evaluate(state) {
    const summary = state.stages[state.current_stage]?.summary
    return summary !== undefined && summary.trim().length > 0
      ? []
      : [`阶段 ${state.current_stage} 未产出摘要——Phase 1 空流水线判据：提供非空摘要即视为完成（§9.3 判据后续按阶段配置化）`]
  },
}

/** 门控决议落盘后的返回。 */
export interface GateResolutionResult {
  readonly advanced: boolean
  readonly current_stage: Stage
  readonly resolution: ResolvedGate
}

/**
 * Cordis 类型扩展：让 `inject: ['projectState']` 的消费者能以
 * `ctx.projectState` 拿到本服务（与 `@deepseek-ai/dsh-tools` 对 `ctx.tools`
 * 的扩展同模式）。
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    projectState: ProjectStateService
  }
}

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'cvagent-state'

/**
 * 项目状态服务。
 *
 * 所有写操作都通过本服务（不经 store 直写），保证内存缓存与磁盘一致；
 * 动态 prompt 章节在每次组装时从缓存读当前阶段/模式/待决门控。
 */
export class ProjectStateService extends Service {
  static inject = ['systemPrompt']

  private readonly store: ProjectStateStore
  private readonly config: ResolvedConfig
  private current: ProjectState | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'projectState')
    // 显式解析默认值：`as ResolvedConfig` 的强转是谎言——schemastery 的默认值
    // 只在 Loader 按 Config schema 校验时注入；直接构造（测试 / 宿主代码）
    // 时 config.projectId 等字段是 undefined，JSON.stringify 会静默丢弃
    // project_id（L1 实测：落盘状态缺 project_id 被形状校验拦下）。
    this.config = {
      projectDir: config.projectDir ?? 'data/projects/default',
      stateFilename: config.stateFilename ?? 'project_state.json',
      projectId: config.projectId ?? 'cv-research-project',
    }
    this.store = createFileStateStore({
      projectDir: this.config.projectDir,
      stateFilename: this.config.stateFilename,
    })

    // 动态章节（勘误 §4.5）：text 是每次组装时求值的函数，
    // 因此阶段推进、模式切换、门控挂起都会在下一步的 prompt 里反映出来。
    ctx.systemPrompt.section({
      name: 'cvagent:state',
      order: 125,
      text: () => this.renderSection(),
    })

    // 预热缓存：第一次组装发生在首个模型步之前，异步加载通常已完成。
    void this.store.load().then((state) => {
      this.current = state
    })
  }

  /** 读取状态；项目不存在时返回 `undefined`（不创建）。 */
  async getState(): Promise<ProjectState | undefined> {
    if (this.current === undefined) this.current = await this.store.load()
    return this.current
  }

  /** 读取状态；项目不存在时创建初始状态（mode 为 null，待主 Agent 询问用户后落盘）。 */
  async getOrCreateState(): Promise<ProjectState> {
    const existing = await this.getState()
    if (existing !== undefined) return existing
    const fresh = createProjectState(this.config.projectId, null)
    await this.save(fresh)
    return fresh
  }

  private async save(state: ProjectState): Promise<void> {
    await this.store.save(state)
    this.current = state
  }

  /**
   * 三段式门控的第 ① 步（勘误 §4.3）：
   * 记录阶段摘要 → 校验完成判据 → 达标则写入待决门控并落盘。
   */
  async requestStageGate(summary: string, now = new Date().toISOString()): Promise<GateDecision> {
    const state = await this.getOrCreateState()
    const stage = state.current_stage
    const previous = state.stages[stage] ?? { status: 'in_progress' as const }
    const staged: ProjectState = {
      ...state,
      stages: {
        ...state.stages,
        [stage]: { ...previous, status: 'in_progress' as const, summary },
      },
    }
    const decision = requestGate(staged, DEFAULT_CRITERIA, now, summary)
    const persisted: ProjectState = decision.gate === null ? staged : { ...staged, pending_gate: decision.gate }
    await this.save(persisted)
    return decision
  }

  /**
   * 三段式门控的第 ③ 步（勘误 §4.3）：
   * 落盘决议并推进；`advance` 时在推进后的状态上生成阶段快照（回滚点）。
   *
   * 无待决门控时 core 会抛错——调用方（工具）把它作为 isError 透给模型，
   * 而不是静默推进。
   */
  async resolveStageGate(decision: string, comment: string | undefined, now = new Date().toISOString()): Promise<GateResolutionResult> {
    const state = await this.getOrCreateState()
    const gatedStage = state.pending_gate?.stage
    const next = resolveGate(state, decision, comment, now)
    await this.save(next)
    if (decision === 'advance' && gatedStage !== undefined) {
      // 快照在 save 之后生成：回滚点保存的是「阶段完成、已推进」的状态。
      // 同一阶段重复推进会覆盖旧快照——Phase 1 已知简化，后续按 §9.1 扩展为
      // 带时间戳的多份快照。
      await this.store.snapshot(gatedStage)
    }
    const resolution = next.resolved_gates[next.resolved_gates.length - 1]
    if (resolution === undefined) {
      throw new Error('resolveStageGate: 决议后没有 resolution 记录（不应发生）')
    }
    return { advanced: resolution.advanced, current_stage: next.current_stage, resolution }
  }

  /** 运行时切换 ABC 模式（§4.2）。 */
  async setMode(mode: Mode): Promise<ProjectState> {
    if (mode !== 'confirm' && mode !== 'supervised' && mode !== 'full_auto') {
      throw new Error(`未知模式 ${JSON.stringify(mode)}；可选：confirm / supervised / full_auto`)
    }
    const state = await this.getOrCreateState()
    await this.save({ ...state, mode })
    return this.current as ProjectState
  }

  /** 回滚至快照点；恢复状态文件并刷新缓存。 */
  async rollback(point: string): Promise<ProjectState> {
    const restored = await this.store.restore(point)
    this.current = restored
    return restored
  }

  /** 列出可用回滚点。 */
  listSnapshots(): Promise<string[]> {
    return this.store.listSnapshots()
  }

  /** 动态 prompt 章节内容（每次组装时求值）。 */
  private renderSection(): string {
    const state = this.current
    if (state === undefined) {
      return '[cv-research 项目状态] 状态尚未加载；可用 cvagent_state_get 读取。'
    }
    const mode = state.mode === null
      ? '未设定（主 Agent 应先经 ask_user_question 询问用户，再用 cvagent_mode_set 落盘）'
      : MODE_LABEL[state.mode]
    const pending = state.pending_gate === null
      ? ''
      : `\n⚠ 有待决门控：阶段 ${state.pending_gate.stage}——${state.pending_gate.summary}\n选项：${state.pending_gate.options.join(' / ')}。`
        + (state.mode === 'confirm'
          ? 'A 模式：必须先经 ask_user_question 取得用户决议，再用 cvagent_gate_resolve 落盘。'
          : 'B/C 模式：可按策略用 cvagent_gate_resolve 落盘推进。')
    const rollback = state.rollback_points.length === 0
      ? ''
      : `\n可用回滚点：${state.rollback_points.join('、')}（cvagent_state_rollback）。`
    return `[cv-research 项目状态] 项目 ${state.project_id}；阶段 ${state.current_stage}；模式：${mode}。${pending}${rollback}`
  }
}

/** 默认导出：loader 按 `module.default` 取插件类（与 dsh-tools / dsh-system-prompt 同约定）。 */
export default ProjectStateService
