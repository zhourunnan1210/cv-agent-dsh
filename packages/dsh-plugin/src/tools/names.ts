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
 * - 全部小写 + 下划线，与 dsh 既有工具风格一致（`ask_user_question`、`todo_write`）；
 * - 前缀 `cvagent_` 表明归属，避免与宿主工具及 Asta MCP 工具（`mcp__asta__*`）冲突；
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
export const STATE_TOOLS = {
  /** 读取 `project_state.json`。 */
  get: 'cvagent_state_get',
  /** 校验完成判据并推进阶段；未达标返回缺失项清单。 */
  advance: 'cvagent_state_advance',
  /** 回滚至快照点。 */
  rollback: 'cvagent_state_rollback',
  /** 运行时切换 ABC 模式。 */
  modeSet: 'cvagent_mode_set',
  /** 落盘 gate 决议（三段式的第 ③ 步，见勘误 §4.3）。 */
  gateResolve: 'cvagent_gate_resolve',
  /**
   * 落盘研究范围（细分领域 + 检索关键词），P3-4 新增。
   *
   * 为什么单独一个工具而不是塞进 `advance`：范围是**用户与 Agent 对话的产物**，
   * 会在知识阶段被反复修订（改关键词、缩小领域），而 `advance` 是阶段出口动作，
   * 两者语义与调用时机都不同。
   */
  scopeSet: 'cvagent_scope_set',
} as const

/** 知识库族（对应 v1.2 §15.2）。 */
export const KB_TOOLS = {
  importPaper: 'cvagent_kb_import_paper',
  /** 批量入库（Scout 检索后的落地口；逐条回传结果，不是"要么全成要么全败"）。 */
  importPapers: 'cvagent_kb_import_papers',
  extract: 'cvagent_kb_extract',
  /**
   * Scout 委派（P3-4）：把"按细分领域与关键词检索论文"委派给只读检索工具的
   * 子代理，返回候选列表；**入库仍由主 Agent 单独调用**（检索与写入职责分离）。
   */
  scout: 'cvagent_kb_scout',
  /**
   * Analyst 委派（P3-4）：把"从 Reader 提取归纳出库条目并去重"委派给子代理，
   * 由它产出条目、由本工具按 §7.5.2 规则写入（`dry_run` 可只回提案）。
   */
  analyze: 'cvagent_kb_analyze',
  upsertEntry: 'cvagent_kb_upsert_entry',
  search: 'cvagent_kb_search',
  summary: 'cvagent_kb_summary',
} as const

/** 领域包族（对应 v1.2 §15.3）。 */
export const DOMAIN_TOOLS = {
  bootstrap: 'cvagent_domain_bootstrap',
  freeze: 'cvagent_domain_freeze',
  proposeRevision: 'cvagent_domain_propose_revision',
  bind: 'cvagent_domain_bind',
} as const

/**
 * Idea 族（对应 v1.2 §15.4）。
 *
 * **实验编排四工具已撤销**（勘误 §12.4，用户裁定）：实验段改为「文件归档原则 + 把执行
 * 交给 dsh（它本身就是 coding harness agent）」，不再做 `exp_plan` / `exp_launch` /
 * `exp_status` / `exp_collect`。
 *
 * 名字是**真的删掉**而不是留在这里当痕迹：留着的名字会进 `ALL_CVAGENT_TOOLS`，
 * 而那个数组的语义是"全部 cvagent 工具名"——里面混着四个永远不会注册的名字，
 * 启动自检与目录体检就都得为它们写例外。撤销的名字不该继续是一份"声明"。
 * 授权门（§4.6）不受影响：GPU 实例 / 计费 API / 破坏性操作仍须委派前取得授权。
 */
export const IDEA_TOOLS = {
  generate: 'cvagent_idea_generate',
  score: 'cvagent_idea_score',
  writeDraft: 'cvagent_write_draft',
} as const

/**
 * 全部 `cvagent.*` 工具名。
 *
 * 用于启动自检：确认注册的工具与 `toolFilter` 引用的名字一致。
 */
export const ALL_CVAGENT_TOOLS = [
  ...Object.values(STATE_TOOLS),
  ...Object.values(KB_TOOLS),
  ...Object.values(DOMAIN_TOOLS),
  ...Object.values(IDEA_TOOLS),
] as const

/**
 * 工具族 → 工具名的映射。
 *
 * 用于按族构造 `toolFilter.allow`（勘误 §4.2 的角色矩阵），避免在委派处
 * 重复罗列字符串。新增工具时只需加入对应族，角色矩阵自动跟随。
 */
export const CVAGENT_TOOL_FAMILIES = {
  state: Object.values(STATE_TOOLS),
  kb: Object.values(KB_TOOLS),
  domain: Object.values(DOMAIN_TOOLS),
  idea: Object.values(IDEA_TOOLS),
} as const

/** 单个 `cvagent.*` 工具名。 */
export type CvAgentToolName = (typeof ALL_CVAGENT_TOOLS)[number]

/**
 * Asta MCP 工具名（Semantic Scholar 学术图谱）。
 *
 * Asta 是 Ai2 的 Scientific Corpus Tool，经 dsh 自带的
 * `@deepseek-ai/dsh-mcp-client` 桥接为原生工具。名字形态由该桥的契约钉死：
 *
 *     mcp__<serverName>__<rawName>
 *
 * 其中 `serverName` 是组合文件里 `config.serverName` 指定的**本地命名空间**
 * （本项目取 `asta`），不是远端自称的名字——远端名字不可信、跨部署不唯一，
 * 且可能随上游升级变化，都不能用来命名模型可见的工具。命名是纯函数，
 * 因此会话历史与权限规则能跨重启与 HMR 存活。
 *
 * 这 8 个名字由 **L1 实证**与真实服务器对齐（`tests/spike-asta-mcp.mjs`：
 * 装载 → 注册 → 真实执行 → 卸载，5 条断言）。离线契约校验在
 * `tests/names.test.mjs`；线上对齐只能由 spike 承担（它需要网络与 key）。
 *
 * ## 与旧检索后端（dsh-ai4scholar）的差异
 *
 * 该 bundle 已于 2026-09-16 从 web profile 停用。有两处能力**没有**随 Asta
 * 回来，是明确接受的损失，不要误以为只是换了个名字：
 *
 * - **没有全文 / PDF 读取**：Asta 只给元数据与正文片段，没有 `read_*`。
 *   全文获取改由 `paper-fetch` skill（DOI → PDF，已归档在 `.dsh/skills/`）
 *   承担，解析后续接 MinerU。
 * - **没有 `auto_cite` / `sci_draw`**：写作阶段的引用插入与科研绘图能力在
 *   本次切换中一并移除，需要时再单独引入。
 *
 * @see tests/spike-asta-mcp.mjs —— 线上 L1 实证
 */
export const ASTA_TOOL_NAMES = {
  /** 主题检索，支持 venue / 日期过滤。 */
  searchByRelevance: 'mcp__asta__search_papers_by_relevance',
  /** 已知标题 → 论文（含 DOI / arXiv 等 externalIds）。 */
  searchByTitle: 'mcp__asta__search_paper_by_title',
  /** 单篇按标识符取详情。 */
  getPaper: 'mcp__asta__get_paper',
  /** 批量取详情；`ids` 必须是 JSON 数组，不是逗号串。 */
  getPaperBatch: 'mcp__asta__get_paper_batch',
  /** 前向引用（谁引用了它）。Asta **没有** `get_references`。 */
  citations: 'mcp__asta__get_citations',
  /** 作者检索：默认只回 `name`，必须显式请求可排序字段。 */
  searchAuthors: 'mcp__asta__search_authors_by_name',
  /** 作者论文列表；字段参数名是 `paper_fields`，默认 `limit=1000`。 */
  authorPapers: 'mcp__asta__get_author_papers',
  /** 正文片段检索：单条 ~500 词、默认 20 条，全族最重的工具。 */
  snippetSearch: 'mcp__asta__snippet_search',
} as const

/**
 * 单个 Asta 工具名。
 *
 * 注意用 `[keyof typeof ...]` 而不是 `[number]`：`ASTA_TOOL_NAMES` 是**对象**
 * 字面量而非数组，对它做数字索引会报 TS2537（no matching index signature for
 * type 'number'）。`ALL_CVAGENT_TOOLS` 是数组，所以那边的 `[number]` 是对的。
 */
export type AstaToolName = (typeof ASTA_TOOL_NAMES)[keyof typeof ASTA_TOOL_NAMES]

/**
 * Scout 角色的 `toolFilter.allow`（勘误 §4.2）：只做检索与去重，回传候选列表。
 *
 * **含 `snippet_search`**（2026-09-17 修正，E32）：它是 Asta 族里**唯一有量**的发现通道
 * ——`search_papers_by_relevance` 的 `limit` 不生效（只回单篇），`search_papers_by_title`
 * 只做标题精确匹配。要一次发现几十篇，只能用 `snippet_search`（limit 100 ≈ 60–70 篇）。
 *
 * 曾一度把它排除在外，理由是 §5.1 的"Scout 只返回候选、不返回正文"。但那条红线的**边界
 * 是主编排上下文**，不是子代理自己的上下文：`snippet_search` 返回的是 ~500 词片段（不是全文），
 * 且只落进 Scout 的一次性上下文（工具回传主 Agent 的只有结构化候选列表）。
 * 与此同时 `ORCHESTRATOR_DENY_TOOLS` 仍然禁止主编排会话直接调用它——**隔离红线由那一侧守**，
 * 不需要靠让 Scout 变瞎来守。
 *
 * 教训：白名单与委派 prompt 是**一对必须同时成立的声明**。此前 prompt 让子代理首选
 * `snippet_search`、白名单却把它剔掉，子代理一调用即被拒（E14 的"响亮拒绝"），
 * 整轮委派随之失败。
 */
export const SCOUT_ALLOWED_TOOLS = [
  ASTA_TOOL_NAMES.snippetSearch,
  ASTA_TOOL_NAMES.searchByRelevance,
  ASTA_TOOL_NAMES.searchByTitle,
  ASTA_TOOL_NAMES.getPaper,
  ASTA_TOOL_NAMES.getPaperBatch,
  ASTA_TOOL_NAMES.citations,
  ASTA_TOOL_NAMES.searchAuthors,
  ASTA_TOOL_NAMES.authorPapers,
] as const

/**
 * Reader 角色的 `toolFilter.allow`：围绕**单篇**取证。
 *
 * ⚠️ 已知缺口：§5.3 要求 Reader 加载单篇全文，而 Asta 不提供全文。当前只能
 * 用 `get_paper`（元数据 / 摘要）与 `snippet_search`（限定 `paper_ids` 的正文
 * 片段）近似替代；真正的全文阅读等 MinerU 解析服务落地后补上
 * （勘误 §5.5 的 S3 项目）。
 */
export const READER_ALLOWED_TOOLS = [
  ASTA_TOOL_NAMES.getPaper,
  ASTA_TOOL_NAMES.snippetSearch,
] as const

/**
 * 主编排会话禁用的重上下文工具（E20 执行级护栏的默认名单）。
 *
 * 名单随检索后端变更而重写：旧名单是 dsh-ai4scholar 的 5 个 `read_*` +
 * 5 个 `download_*`，而 Asta 里**这两个前缀一个都不存在**。
 *
 * 剩下的重上下文工具只有一个：`snippet_search`——单条 ~500 词、默认 20 条，
 * 是全族里每行最重的。其余 7 个返回元数据行，量级由 `limit` 控制。
 */
export const ORCHESTRATOR_DENY_TOOLS = [
  ASTA_TOOL_NAMES.snippetSearch,
] as const
