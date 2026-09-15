/**
 * 大 Loop 状态机与门控逻辑（平台无关，纯函数）。
 *
 * 设计依据：v1.2 文档 §4、§9.1、§9.3，以及勘误文档
 * `docs/CV-Research-Agent_勘误与修订设计-v1.3.md` §4.3 的**修订**门控设计。
 *
 * ## 为什么本文件与 v1.2 §10 的接口不同
 *
 * v1.2 §10 把 `advance()` 描述为「触发 gate / 事件」，并把
 * `cvagent.gate.request` 描述为「向用户呈现阶段摘要并等待选择；A 模式阻塞」。
 * 工具调用无法在单次执行内等待用户输入，这是模型-工具协议的结构性限制。
 *
 * 因此门控被拆成三段（勘误 §4.3）：
 *
 * 1. `requestGate()` —— 判定阶段出口，写入待决 gate 状态；
 * 2. **呈递** —— 由 dsh 侧调用 `ask_user_question` 完成，**不在本层**；
 * 3. `resolveGate()` —— 落盘用户决议，`advance()` 据模式决定是否推进。
 *
 * 本层只实现 1 和 3，且是**纯函数**：不碰文件、不调 LLM、不依赖 dsh。
 * 副作用（读写 `project_state.json`、发事件）落在 `packages/dsh-plugin`。
 */
/** 大 Loop 阶段（v1.2 §9.1）。 */
export type Stage = 'knowledge_building' | 'idea_generation' | 'idea_scoring' | 'experiment' | 'writing';
/** 阶段顺序，`advance` 依此推进。 */
export declare const STAGE_ORDER: readonly ["knowledge_building", "idea_generation", "idea_scoring", "experiment", "writing"];
/** 自主性治理模式（v1.2 §4.1）。 */
export type Mode = 'confirm' | 'supervised' | 'full_auto';
/** 阶段状态。 */
export type StageStatus = 'pending' | 'in_progress' | 'awaiting_gate' | 'completed' | 'failed';
/** 单个阶段的记录。 */
export interface StageRecord {
    readonly status: StageStatus;
    /** 阶段产出的自由摘要，供呈递与审计。 */
    readonly summary?: string;
    readonly completed_at?: string;
    /** 完成后自动快照的回滚点标识（v1.2 §9.1）。 */
    readonly rollback_point?: string;
}
/**
 * 待决 gate。
 *
 * 存在该字段即表示「阶段出口已判定达标，等待决议」。
 * A 模式必须经呈递取得决议后才能推进；B/C 模式按策略自动放行。
 */
export interface PendingGate {
    readonly stage: Stage;
    /** 呈递给用户的阶段摘要。 */
    readonly summary: string;
    /** 可选项，如 `['advance', 'revise', 'rollback']`。 */
    readonly options: readonly string[];
    readonly requested_at: string;
}
/** 已决议的 gate 记录，保留供审计。 */
export interface ResolvedGate {
    readonly stage: Stage;
    readonly decision: string;
    readonly comment?: string;
    readonly resolved_at: string;
    /** 决议后是否实际推进了阶段。 */
    readonly advanced: boolean;
}
/** 项目状态（`project_state.json` 的内存形态，v1.2 §9.1）。 */
export interface ProjectState {
    readonly project_id: string;
    readonly current_stage: Stage;
    /** `null` 表示会话尚未确定模式，dsh 侧应主动询问一次并落盘（勘误 §4.3）。 */
    readonly mode: Mode | null;
    readonly stages: Readonly<Partial<Record<Stage, StageRecord>>>;
    readonly pending_gate: PendingGate | null;
    readonly resolved_gates: readonly ResolvedGate[];
    readonly rollback_points: readonly string[];
}
/** 阶段出口判定结果。 */
export interface GateDecision {
    /** 完成判据是否全部满足。 */
    readonly satisfied: boolean;
    /** 未满足项清单，直接回传给 Agent 作为「缺什么」的说明。 */
    readonly missing: readonly string[];
    /** 满足判据时，写入待决状态的 gate；不满足时为 `null`。 */
    readonly gate: PendingGate | null;
}
/** 单个阶段的完成判据（v1.2 §9.3）。 */
export interface GateCriteria {
    /** 判据逐项求值；返回未满足项。 */
    evaluate(state: ProjectState): readonly string[];
}
/**
 * 判定阶段出口（勘误 §4.3 第 ① 步）。
 *
 * 纯函数：只读取状态与判据，产出「是否达标 + 待决 gate」。
 * **不修改传入的 state**，调用方（dsh 侧）负责落盘。
 *
 * @param state - 当前项目状态。
 * @param criteria - 当前阶段的完成判据。
 * @param now - ISO 时间戳，注入以便测试。
 * @returns 判定结果；`gate` 非空时调用方应将其写入状态并（按模式）呈递。
 */
export declare function requestGate(state: ProjectState, criteria: GateCriteria, now: string, summary: string): GateDecision;
/**
 * 判断某模式下的 gate 是否需要人工决议（勘误 §4.3 表）。
 *
 * - `confirm`：必须呈递并等待用户答复后才推进；
 * - `supervised`：不主动询问，但记录 gate，用户可主动介入；
 * - `full_auto`：自动放行，记入报告。
 *
 * 该判定与「是否呈递」解耦：呈递本身由 dsh 侧实现，本函数只回答
 * **需不需要人**。这使得「无人在场时 A 模式会卡住」成为显式语义而非意外。
 */
export declare function requiresHumanDecision(mode: Mode | null): boolean;
/**
 * 落盘决议并推进（勘误 §4.3 第 ③ 步）。
 *
 * 纯函数：返回新状态，不修改传入对象。
 *
 * 语义边界：
 * - 无待决 gate 时视为调用方错误，抛出（而非静默推进）；
 * - `decision` 非 `advance`（即 `revise` / `rollback`）时**不推进阶段**，
 *   只清除 gate 并记录，由调用方按 `decision` 决定后续动作；
 * - `advance` 时把当前阶段置为 `completed`、写入回滚点，并把
 *   `current_stage` 移到下一阶段；已是最后阶段则停在 `writing` 并标记完成。
 *
 * @throws 当 `state.pending_gate` 为空时。
 */
export declare function resolveGate(state: ProjectState, decision: string, comment: string | undefined, now: string): ProjectState;
/**
 * 创建初始状态。
 *
 * @param projectId - 项目标识。
 * @param mode - 初始模式；`null` 表示待 dsh 侧询问一次后落盘。
 */
export declare function createProjectState(projectId: string, mode?: Mode | null): ProjectState;
//# sourceMappingURL=machine.d.ts.map