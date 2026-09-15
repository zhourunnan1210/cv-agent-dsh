/**
 * `cvagent.*` 工具名契约。
 *
 * ## 为什么需要这个文件
 *
 * S1 实证（`tests/spike-s1-tool-isolation.mjs`，断言 S1-j）确认：
 * `ToolRuntime.restrict()` 在过滤器里出现**未知工具名**时会直接抛错，
 * 并回报已知工具清单：
 *
 * ```
 * tools.restrict() names unknown global tool "spike_does_not_exist";
 * known global tools: spike_exec_code, spike_read, spike_search
 * ```
 *
 * 这既是好事（拼写错误不会静默失效），也意味着**委派时的 `toolFilter`
 * 必须引用真实注册的工具名**。若把工具名散落成字符串字面量，Phase 1 改一个
 * 工具名就会让某条委派路径在运行时炸掉。
 *
 * 因此工具名在此集中声明，作为唯一权威来源：注册处与 `toolFilter` 都从这里取。
 *
 * ## 命名约定
 *
 * - 全部小写 + 下划线，与 dsh 既有工具风格一致（`search_semantic`、`auto_cite`）；
 * - 前缀 `cvagent_` 表明归属，避免与 dsh-ai4scholar 的 38 个工具及宿主工具冲突；
 * - 名字一经发布不得更改（会破坏已记录会话的回放与既存 `toolFilter`）。
 *
 * ## 与 v1.2 §15 的差异
 *
 * v1.2 §15 用点号命名（`cvagent.state.get`）。实测 dsh 既有工具全部使用下划线
 * 命名，且工具名会进入 `toolFilter` 与日志，故统一改为下划线。语义一一对应：
 * `cvagent.state.get` → `cvagent_state_get`。
 *
 * 本文件只声明名字，不注册工具；注册在 `packages/dsh-plugin` 中完成。
 */
/** 状态与门控族（对应 v1.2 §15.1）。 */
export declare const STATE_TOOLS: {
    /** 读取 `project_state.json`。 */
    readonly get: "cvagent_state_get";
    /** 校验完成判据并推进阶段；未达标返回缺失项清单。 */
    readonly advance: "cvagent_state_advance";
    /** 回滚至快照点。 */
    readonly rollback: "cvagent_state_rollback";
    /** 运行时切换 ABC 模式。 */
    readonly modeSet: "cvagent_mode_set";
    /** 落盘 gate 决议（三段式的第 ③ 步，见勘误 §4.3）。 */
    readonly gateResolve: "cvagent_gate_resolve";
};
/** 知识库族（对应 v1.2 §15.2）。 */
export declare const KB_TOOLS: {
    readonly importPaper: "cvagent_kb_import_paper";
    readonly extract: "cvagent_kb_extract";
    readonly upsertEntry: "cvagent_kb_upsert_entry";
    readonly search: "cvagent_kb_search";
    readonly summary: "cvagent_kb_summary";
};
/** 领域包族（对应 v1.2 §15.3）。 */
export declare const DOMAIN_TOOLS: {
    readonly bootstrap: "cvagent_domain_bootstrap";
    readonly freeze: "cvagent_domain_freeze";
    readonly proposeRevision: "cvagent_domain_propose_revision";
    readonly bind: "cvagent_domain_bind";
};
/** Idea 与实验族（对应 v1.2 §15.4）。 */
export declare const IDEA_TOOLS: {
    readonly generate: "cvagent_idea_generate";
    readonly score: "cvagent_idea_score";
    readonly expPlan: "cvagent_exp_plan";
    readonly expLaunch: "cvagent_exp_launch";
    readonly expStatus: "cvagent_exp_status";
    readonly expCollect: "cvagent_exp_collect";
    readonly writeDraft: "cvagent_write_draft";
};
/**
 * 全部 `cvagent.*` 工具名。
 *
 * 用于启动自检：确认注册的工具与 `toolFilter` 引用的名字一致。
 */
export declare const ALL_CVAGENT_TOOLS: readonly ("cvagent_state_get" | "cvagent_state_advance" | "cvagent_state_rollback" | "cvagent_mode_set" | "cvagent_gate_resolve" | "cvagent_kb_import_paper" | "cvagent_kb_extract" | "cvagent_kb_upsert_entry" | "cvagent_kb_search" | "cvagent_kb_summary" | "cvagent_domain_bootstrap" | "cvagent_domain_freeze" | "cvagent_domain_propose_revision" | "cvagent_domain_bind" | "cvagent_idea_generate" | "cvagent_idea_score" | "cvagent_exp_plan" | "cvagent_exp_launch" | "cvagent_exp_status" | "cvagent_exp_collect" | "cvagent_write_draft")[];
/** 单个 `cvagent.*` 工具名。 */
export type CvAgentToolName = (typeof ALL_CVAGENT_TOOLS)[number];
/**
 * dsh-ai4scholar 中本项目依赖的工具名。
 *
 * 由 L1 实证得出（`tests/smoke-vendor-plugin.mjs` 打印的 38 个工具全名单），
 * 因此可以安全用于 `toolFilter`。只列出本项目实际引用的部分，不是全量 38 个。
 *
 * @see packages/vendor/dsh-ai4scholar —— 38 个工具的权威定义处
 */
export declare const VENDOR_TOOL_NAMES: {
    /** 统一跨平台检索（§5.1 核心）。 */
    readonly searchPapers: "search_papers";
    /** 标题匹配，用于本地百篇论文的元数据补全（§5.1 用户约束）。 */
    readonly matchPaper: "search_semantic_paper_match";
    /** 引用图：某论文引用了谁。 */
    readonly citations: "get_semantic_citations";
    /** 引用图：谁引用了某论文。 */
    readonly references: "get_semantic_references";
    /** 基于已有论文的推荐发现。 */
    readonly recommendations: "get_semantic_recommendations";
    /** 单篇推荐。 */
    readonly recommendationsForPaper: "get_semantic_recommendations_for_paper";
    /** 全文读取（快速通道）。 */
    readonly readSemanticPaper: "read_semantic_paper";
    readonly readArxivPaper: "read_arxiv_paper";
    readonly readByDoi: "read_by_doi";
    /** 真实引用插入 + BibTeX（§8.2 写作）。 */
    readonly autoCite: "auto_cite";
    /** 科研图生成（§8.2 写作）。 */
    readonly sciDraw: "sci_draw";
    /** 计费额度查询（§20 成本模型）。 */
    readonly credits: "get_ai4scholar_credits";
};
/** 检索族工具名集合，供 Scout 角色的 `toolFilter.allow` 直接使用。 */
export declare const SCOUT_ALLOWED_TOOLS: readonly ["search_papers", "search_semantic_paper_match", "get_semantic_citations", "get_semantic_references", "get_semantic_recommendations", "get_semantic_recommendations_for_paper"];
//# sourceMappingURL=names.d.ts.map