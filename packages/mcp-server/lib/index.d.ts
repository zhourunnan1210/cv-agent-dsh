/**
 * @cv-research/mcp —— 核心能力的 MCP 服务化封装。
 *
 * ## 现状
 *
 * **占位模块。** 本包的实质实现在 Phase 1 之后（v1.2 §12；勘误 §5.5 的
 * Spike S5：「把 `kb.search` + `idea.score` 两个接口包成 MCP，从 dsh 和
 * 另一个 MCP 客户端各调用一次」）。
 *
 * 之所以先建包并导出真实符号，是为了让 workspace 的 `typecheck` / `build`
 * 门禁从第一天起就有意义——空 `src/` 会让 `tsc` 以 TS18003 失败，从而掩盖
 * 真正的编译错误。
 *
 * ## 设计约束（提前记录，避免后续返工）
 *
 * 1. 本包只依赖 `@cv-research/core`，**不依赖 dsh / Cordis**——这是
 *    v1.2 §3.3「不锁定单一 Agent 运行时」的落点：MCP 是跨平台复用面。
 * 2. 暴露的能力必须是 core 层已有的平台无关接口，不得为了 MCP 而在
 *    core 里新增 dsh 相关概念。
 * 3. 凭证同样走环境变量 / credentials 注入，密钥字面值不进入任何返回值
 *    （v1.2 §23 密钥卫生）。
 *
 * @module @cv-research/mcp
 */
import type { KnowledgeBase, ScoringReport } from '@cv-research/core';
/**
 * 计划暴露为 MCP tool 的能力清单（Phase 1 后实现）。
 *
 * 依据 v1.2 §12 的 Spike S5：优先封装 `kb.search` 与 `idea.score`，
 * 因为这两个是「知识检索」与「Idea 决策」两层里最独立、最可复用的接口。
 */
export declare const PLANNED_MCP_CAPABILITIES: readonly [{
    readonly name: "kb_search";
    readonly purpose: "三库向量/关键词检索，供撞车分析调用";
    readonly core: "KnowledgeBase.similarProblems / similarMethods";
}, {
    readonly name: "kb_summary";
    readonly purpose: "三库摘要（计数 + top 条目标题），供 Idea 生成";
    readonly core: "KnowledgeBase.summarize";
}, {
    readonly name: "idea_score";
    readonly purpose: "撞车分析 + 四维打分，产出打分报告";
    readonly core: "IdeaScorer.score";
}];
/**
 * MCP 服务端工厂的签名（占位）。
 *
 * @param kb - 三库实现；由宿主（dsh 插件或独立进程）注入。
 * @returns 一个尚未注册到任何 MCP transport 的服务端句柄。
 */
export type CreateMcpServer = (kb: KnowledgeBase) => Promise<{
    readonly capabilities: typeof PLANNED_MCP_CAPABILITIES;
    readonly close: () => Promise<void>;
}>;
/** 打分报告的类型转发，便于 MCP 客户端只依赖本包即可获得返回类型。 */
export type { ScoringReport };
//# sourceMappingURL=index.d.ts.map