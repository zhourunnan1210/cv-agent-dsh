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
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type GateDecision, type Mode, type ProjectState, type ResolvedGate, type Stage } from '@cv-research/core';
/** 插件配置；每个部署可变的取值都是带默认值的字段（与 vendored 插件同约定）。 */
export interface Config {
    /** 项目数据目录；`project_state.json` 落在这里。 */
    projectDir?: string;
    /** 状态文件名。 */
    stateFilename?: string;
    /** 新建项目时写入的 project_id。 */
    projectId?: string;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    projectDir: Schema<string, string>;
    stateFilename: Schema<string, string>;
    projectId: Schema<string, string>;
}>, Schemastery.ObjectT<{
    projectDir: Schema<string, string>;
    stateFilename: Schema<string, string>;
    projectId: Schema<string, string>;
}>>;
/** 门控决议落盘后的返回。 */
export interface GateResolutionResult {
    readonly advanced: boolean;
    readonly current_stage: Stage;
    readonly resolution: ResolvedGate;
}
/**
 * Cordis 类型扩展：让 `inject: ['projectState']` 的消费者能以
 * `ctx.projectState` 拿到本服务（与 `@deepseek-ai/dsh-tools` 对 `ctx.tools`
 * 的扩展同模式）。
 */
declare module '@deepseek-ai/cordis' {
    interface Context {
        projectState: ProjectStateService;
    }
}
/** Cordis 插件名（loader 诊断用）。 */
export declare const name = "cvagent-state";
/**
 * 项目状态服务。
 *
 * 所有写操作都通过本服务（不经 store 直写），保证内存缓存与磁盘一致；
 * 动态 prompt 章节在每次组装时从缓存读当前阶段/模式/待决门控。
 */
export declare class ProjectStateService extends Service {
    static inject: string[];
    private readonly store;
    private readonly config;
    private current;
    constructor(ctx: Context, config: Config);
    /** 读取状态；项目不存在时返回 `undefined`（不创建）。 */
    getState(): Promise<ProjectState | undefined>;
    /** 读取状态；项目不存在时创建初始状态（mode 为 null，待主 Agent 询问用户后落盘）。 */
    getOrCreateState(): Promise<ProjectState>;
    private save;
    /**
     * 三段式门控的第 ① 步（勘误 §4.3）：
     * 记录阶段摘要 → 校验完成判据 → 达标则写入待决门控并落盘。
     */
    requestStageGate(summary: string, now?: string): Promise<GateDecision>;
    /**
     * 三段式门控的第 ③ 步（勘误 §4.3）：
     * 落盘决议并推进；`advance` 时在推进后的状态上生成阶段快照（回滚点）。
     *
     * 无待决门控时 core 会抛错——调用方（工具）把它作为 isError 透给模型，
     * 而不是静默推进。
     */
    resolveStageGate(decision: string, comment: string | undefined, now?: string): Promise<GateResolutionResult>;
    /** 运行时切换 ABC 模式（§4.2）。 */
    setMode(mode: Mode): Promise<ProjectState>;
    /** 回滚至快照点；恢复状态文件并刷新缓存。 */
    rollback(point: string): Promise<ProjectState>;
    /** 列出可用回滚点。 */
    listSnapshots(): Promise<string[]>;
    /** 动态 prompt 章节内容（每次组装时求值）。 */
    private renderSection;
}
/** 默认导出：loader 按 `module.default` 取插件类（与 dsh-tools / dsh-system-prompt 同约定）。 */
export default ProjectStateService;
//# sourceMappingURL=service.d.ts.map