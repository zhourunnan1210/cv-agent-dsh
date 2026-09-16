# cv-research agent preset（权威源）

本目录是 `cv-research` preset 组合的**权威源**（随仓库版本控制）。

**工作副本**挂在用户预设根：`${DSH_HOME:-$HOME/.dsh}/.agent-presets/cv-research/`。
两处的关系与同步约定：

- 权威源在仓库（这里）；工作副本由 `copy(standard → cv-research)` 生成后，
  以本目录内容覆盖（或直接目录复制）。
- **只改仓库里的这份，再同步到工作副本**；不要反过来——`~/.dsh` 下的副本
  不在版本控制里，改错了没有历史可回滚。
- 同步后必须 mount-validate（`agentPresets.standingKeyFor('cv-research')`，
  见 docs 勘误 §7）。

## 与 standard 的差异

| 差异点 | 内容 |
| --- | --- |
| persona | 换成 CV Research Orchestrator 人设（保持精简；阶段/模式/门控的实时上下文由 `cv-agent-dsh/state` 的动态 prompt 章节注入，勘误 §4.5） |
| 新增 group | `cvagent-state-group`：`isolate: { projectState: true }`，内含 `cv-agent-dsh/state`（服务）与 `cv-agent-dsh/state-tools`（工具行）——服务平面归属按勘误 §4.4.1 裁定 |
| 新增 group | `cvagent-kb-group`：`isolate: { kb: true }`，内含 `cv-agent-dsh/kb`（论文库服务）、`cv-agent-dsh/kb-tools`（`cvagent_kb_import_paper`）与 `cv-agent-dsh/kb-extract`（`cvagent_kb_extract`，Reader 子代理委派提取） |
| 新增行 | `cvagent-orchestrator-guard`（E20 执行级护栏，置 isolate group 之外——它不提供服务） |
| 新增行 | `mcp-asta`：Asta MCP 学术检索（`@deepseek-ai/dsh-mcp-client`，工具名 `mcp__asta__*`） |
| 其余 | 与 standard 完全一致（编码工具、委派、skills、目标等全部保留） |

## 依赖

1. `cv-agent-dsh` 包必须已链入 profile（`dsh plugin --profile <name> add link:<path>`），
   否则 mount-validate 报「rows name plugins that cannot be resolved」。
2. `mcp-asta` 行需要两个环境变量（宿主机启动前设好，缺一不可）：
   - `ASTA_API_KEY`；
   - `HTTPS_PROXY` **加** `NODE_USE_ENV_PROXY=1`——Node 24 的 global fetch 没有
     后者会直接忽略前者，而 MCP transport 正是 fetch（实测：只有代理 = 403，
     代理 + flag = 200）。

   缺任一条件时该行连不上，日志有错，但**不会**拖垮 preset 挂载——这是刻意
   选择 `failOnStartupError` 保持默认 false 的原因：网络故障不该让整个
   Orchestrator 会话起不来。

## 检索后端：Asta MCP（2026-09-16 起）

`dsh-ai4scholar` bundle 已从 web profile 停用，学术检索改走 Asta（Ai2 的
Scientific Corpus Tool，Semantic Scholar 图谱）。

**两处能力没有随 Asta 回来**，是明确接受的损失：

- **无全文 / PDF 读取**：Asta 只给元数据与正文片段。全文获取由 `paper-fetch`
  skill 承担（**由本插件包自己拥有**，在 `packages/dsh-plugin/skills/paper-fetch/`，
  随包分发），解析后续接 MinerU（端点与限流见 `docs/mineru-api.md`）。
- **无 `auto_cite` / `sci_draw`**：写作阶段的引用插入与科研绘图一并移除。

契约与角色矩阵已同步更新：`packages/dsh-plugin/src/tools/names.ts` 的
`ASTA_TOOL_NAMES` / `SCOUT_ALLOWED_TOOLS` / `READER_ALLOWED_TOOLS` /
`ORCHESTRATOR_DENY_TOOLS`，以及 `tests/role-matrix.test.mjs`。

## 已知限制（E20）

Asta 的 8 个工具由本 preset 注册，因此 **Orchestrator 的目录里能看到
`snippet_search`**（全族最重的工具：单条 ~500 词、默认 20 条）。它无法用
`toolFilter` 移除——主 Agent 是根作用域，`restrict()` 会抛错（§4.1）。

拦截由 `cvagent-orchestrator-guard` 在 `tools/pre-execute` 上**执行级**完成：
根 agent 调用被禁工具即 deny，子代理不受影响（归 toolFilter 管）。
目录级隐藏仍需 dsh 提供 setup 扩展点，见 docs 勘误 E20。
