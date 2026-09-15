/**
 * `project_state.json` 的持久化层（dsh 侧，文件 I/O）。
 *
 * 设计依据：v1.2 §9.1（状态文件为阶段间唯一权威状态）、勘误 §4.3（三段式门控）。
 *
 * ## 分层
 *
 * 状态**语义**（阶段迁移、门控判定、模式差异）在 `@cv-research/core` 里，
 * 是纯函数；本文件只负责把它落到磁盘、读回来、以及生成快照。
 * 这是 v1.2 §3.3 表格「状态机：状态定义与迁移属 core，事件发布/文件写入属
 * dsh-plugin」的落点。
 *
 * ## 为什么状态文件不能存进对话历史
 *
 * v1.2 原则五：状态持久化于文件，而非对话历史。文件态带来三件事——可持久化、
 * 可回滚、可跨会话恢复，且不占 Agent 上下文。因此本层的读写在每次状态变更时
 * 都必须是**完整且原子**的：一个写坏的 `project_state.json` 会让整个大 Loop
 * 失去权威状态。
 *
 * ## 原子写
 *
 * 先写临时文件、再 rename 覆盖。rename 在同一文件系统内是原子的，因此
 * 进程若在写入中途被杀，磁盘上要么是旧状态、要么是新状态，**不会出现半截
 * JSON**。这一点在 C 模式长时运行（夜间无人值守）时尤其重要——崩溃恢复后
 * 还能读到一致状态，而不是一个解析失败的残file。
 */

import { mkdir, readFile, rename, writeFile, copyFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ProjectState, Stage } from '@cv-research/core'

/**
 * 状态仓库接口。
 *
 * 刻意保持窄：只有「读 / 写 / 快照」三个动作。门控与阶段迁移的判定不在这里，
 * 而在 core 的纯函数里——本层不做任何业务判断，只做持久化。
 */
export interface ProjectStateStore {
  /** 读取状态；文件不存在时返回 `undefined`（区别于解析失败）。 */
  load(): Promise<ProjectState | undefined>
  /** 原子写入状态。 */
  save(state: ProjectState): Promise<void>
  /** 为某阶段生成快照，返回快照标识。 */
  snapshot(stage: Stage): Promise<string>
  /** 列出已有快照标识。 */
  listSnapshots(): Promise<string[]>
  /** 回滚到指定快照，返回恢复后的状态。 */
  restore(point: string): Promise<ProjectState>
}

/** 状态文件与快照的落盘布局。 */
export interface StateStoreLayout {
  /** 项目数据根目录，如 `<workspace>/data/projects/deepfake-001`。 */
  readonly projectDir: string
  /** 状态文件名，默认 `project_state.json`。 */
  readonly stateFilename?: string
}

/** 快照目录名（相对 `projectDir`）。 */
const SNAPSHOT_DIR = 'snapshots'

/**
 * 校验从磁盘读回的对象是否像一个 `ProjectState`。
 *
 * 只做形状校验，不做语义校验——语义由 core 的纯函数在使用时保证。
 * 目的是尽早发现「文件被手工改坏」或「版本不兼容」，而不是信任磁盘内容。
 *
 * @throws 当形状不符时，抛出带文件路径的错误。
 */
function assertProjectState(value: unknown, path: string): asserts value is ProjectState {
  const problems: string[] = []
  if (typeof value !== 'object' || value === null) {
    problems.push('顶层不是对象')
  } else {
    const candidate = value as Record<string, unknown>
    if (typeof candidate.project_id !== 'string') problems.push('project_id 缺失或非字符串')
    if (typeof candidate.current_stage !== 'string') problems.push('current_stage 缺失或非字符串')
    if (!('mode' in candidate)) problems.push('mode 字段缺失（可为 null，但必须存在）')
    if (typeof candidate.stages !== 'object' || candidate.stages === null) problems.push('stages 缺失或非对象')
    if (!('pending_gate' in candidate)) problems.push('pending_gate 字段缺失（可为 null，但必须存在）')
    if (!Array.isArray(candidate.resolved_gates)) problems.push('resolved_gates 缺失或非数组')
    if (!Array.isArray(candidate.rollback_points)) problems.push('rollback_points 缺失或非数组')
  }
  if (problems.length > 0) {
    throw new Error(`project_state.json 形状非法（${path}）：${problems.join('；')}`)
  }
}

/**
 * 基于文件系统的状态仓库。
 *
 * @param layout - 落盘布局。
 */
export function createFileStateStore(layout: StateStoreLayout): ProjectStateStore {
  const stateFilename = layout.stateFilename ?? 'project_state.json'
  const statePath = join(layout.projectDir, stateFilename)
  const snapshotRoot = join(layout.projectDir, SNAPSHOT_DIR)

  async function ensureDirs(): Promise<void> {
    await mkdir(layout.projectDir, { recursive: true })
  }

  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(statePath, 'utf8')
      } catch (error) {
        // 文件不存在是合法情形（项目尚未开始）；其余 I/O 错误必须上抛，
        // 否则会把「读不到」误当成「没有状态」，导致后续静默从头开始。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`project_state.json 解析失败（${statePath}）：${(error as Error).message}`)
      }
      assertProjectState(parsed, statePath)
      return parsed
    },

    async save(state) {
      await ensureDirs()
      const tmpPath = `${statePath}.tmp`
      // 缩进 2 空格：状态文件是给人看的可审计产物（v1.2 §9.1），不是紧凑传输格式。
      await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(tmpPath, statePath)
    },

    async snapshot(stage) {
      const state = await this.load()
      if (state === undefined) {
        throw new Error(`无法为阶段 ${stage} 生成快照：${statePath} 不存在`)
      }
      await mkdir(snapshotRoot, { recursive: true })
      // 快照名与 v1.2 §9.1 的 rollback_points 一致：after_<stage>。
      const point = `after_${stage}`
      await copyFile(statePath, join(snapshotRoot, `${point}.json`))
      return point
    },

    async listSnapshots() {
      let entries: string[]
      try {
        entries = await readdir(snapshotRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      return entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort()
    },

    async restore(point) {
      const snapshotPath = join(snapshotRoot, `${point}.json`)
      let raw: string
      try {
        raw = await readFile(snapshotPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const available = await this.listSnapshots()
          throw new Error(`快照 ${point} 不存在；可用快照：${available.join(', ') || '(无)'}`)
        }
        throw error
      }
      const parsed: unknown = JSON.parse(raw)
      assertProjectState(parsed, snapshotPath)
      // 恢复 = 用快照覆盖当前状态，同样走原子写。
      await this.save(parsed)
      return parsed
    },
  }
}

/**
 * 判断状态文件是否存在（不做解析）。
 *
 * 供 dsh 侧在会话启动时决定「要不要问一次模式」：文件不存在说明是全新项目。
 */
export async function stateExists(layout: StateStoreLayout): Promise<boolean> {
  try {
    await stat(join(layout.projectDir, layout.stateFilename ?? 'project_state.json'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 供测试与调用方复用的路径计算。 */
export function statePaths(layout: StateStoreLayout): { statePath: string; snapshotRoot: string } {
  return {
    statePath: join(layout.projectDir, layout.stateFilename ?? 'project_state.json'),
    snapshotRoot: join(layout.projectDir, SNAPSHOT_DIR),
  }
}
