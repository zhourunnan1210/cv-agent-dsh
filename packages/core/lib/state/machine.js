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
/** 阶段顺序，`advance` 依此推进。 */
export const STAGE_ORDER = [
    'knowledge_building',
    'idea_generation',
    'idea_scoring',
    'experiment',
    'writing',
];
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
export function requestGate(state, criteria, now, summary) {
    const missing = criteria.evaluate(state);
    if (missing.length > 0)
        return { satisfied: false, missing, gate: null };
    return {
        satisfied: true,
        missing: [],
        gate: {
            stage: state.current_stage,
            summary,
            options: ['advance', 'revise', 'rollback'],
            requested_at: now,
        },
    };
}
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
export function requiresHumanDecision(mode) {
    // 模式未定时保守处理：按 confirm 对待，促使 dsh 侧先问一次。
    return mode === null || mode === 'confirm';
}
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
export function resolveGate(state, decision, comment, now) {
    const gate = state.pending_gate;
    if (gate === null) {
        throw new Error(`resolveGate: 阶段 ${state.current_stage} 没有待决 gate，不能落盘决议`);
    }
    const advanced = decision === 'advance';
    const currentIndex = STAGE_ORDER.indexOf(state.current_stage);
    const nextStage = STAGE_ORDER[currentIndex + 1];
    const completedRecord = {
        status: 'completed',
        ...(gate.summary === '' ? {} : { summary: gate.summary }),
        completed_at: now,
        rollback_point: `after_${gate.stage}`,
    };
    const previousRecord = state.stages[gate.stage] ?? { status: 'in_progress' };
    const stages = {
        ...state.stages,
        [gate.stage]: advanced ? completedRecord : { ...previousRecord, status: 'in_progress' },
    };
    if (advanced && nextStage !== undefined) {
        stages[nextStage] = stages[nextStage] ?? { status: 'pending' };
    }
    const resolved = {
        stage: gate.stage,
        decision,
        ...(comment === undefined ? {} : { comment }),
        resolved_at: now,
        advanced,
    };
    return {
        ...state,
        current_stage: advanced && nextStage !== undefined ? nextStage : state.current_stage,
        stages,
        pending_gate: null,
        resolved_gates: [...state.resolved_gates, resolved],
        rollback_points: advanced ? [...state.rollback_points, `after_${gate.stage}`] : state.rollback_points,
    };
}
/**
 * 创建初始状态。
 *
 * @param projectId - 项目标识。
 * @param mode - 初始模式；`null` 表示待 dsh 侧询问一次后落盘。
 */
export function createProjectState(projectId, mode = null) {
    return {
        project_id: projectId,
        current_stage: 'knowledge_building',
        mode,
        stages: { knowledge_building: { status: 'pending' } },
        pending_gate: null,
        resolved_gates: [],
        rollback_points: [],
    };
}
//# sourceMappingURL=machine.js.map