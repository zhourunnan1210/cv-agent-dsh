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
import type { ProjectState, Stage } from '@cv-research/core';
/**
 * 状态仓库接口。
 *
 * 刻意保持窄：只有「读 / 写 / 快照」三个动作。门控与阶段迁移的判定不在这里，
 * 而在 core 的纯函数里——本层不做任何业务判断，只做持久化。
 */
export interface ProjectStateStore {
    /** 读取状态；文件不存在时返回 `undefined`（区别于解析失败）。 */
    load(): Promise<ProjectState | undefined>;
    /** 原子写入状态。 */
    save(state: ProjectState): Promise<void>;
    /** 为某阶段生成快照，返回快照标识。 */
    snapshot(stage: Stage): Promise<string>;
    /** 列出已有快照标识。 */
    listSnapshots(): Promise<string[]>;
    /** 回滚到指定快照，返回恢复后的状态。 */
    restore(point: string): Promise<ProjectState>;
}
/** 状态文件与快照的落盘布局。 */
export interface StateStoreLayout {
    /** 项目数据根目录，如 `<workspace>/data/projects/deepfake-001`。 */
    readonly projectDir: string;
    /** 状态文件名，默认 `project_state.json`。 */
    readonly stateFilename?: string;
}
/**
 * 基于文件系统的状态仓库。
 *
 * @param layout - 落盘布局。
 */
export declare function createFileStateStore(layout: StateStoreLayout): ProjectStateStore;
/**
 * 判断状态文件是否存在（不做解析）。
 *
 * 供 dsh 侧在会话启动时决定「要不要问一次模式」：文件不存在说明是全新项目。
 */
export declare function stateExists(layout: StateStoreLayout): Promise<boolean>;
/** 供测试与调用方复用的路径计算。 */
export declare function statePaths(layout: StateStoreLayout): {
    statePath: string;
    snapshotRoot: string;
};
//# sourceMappingURL=store.d.ts.map