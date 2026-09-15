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
| 其余 | 与 standard 完全一致（编码工具、委派、skills、目标等全部保留） |

## 依赖

`cv-agent-dsh` 包必须已链入 profile（`dsh plugin --profile <name> add link:<path>`），
否则 mount-validate 报「rows name plugins that cannot be resolved」。

## 已知限制（E20）

dsh-ai4scholar 的 38 个工具注册在 profile bundle 层（宿主平面），对本 preset 的
会话**全局可见**——preset 组合无法为 Orchestrator 移除 `read_*` 等重上下文工具。
主 Agent 自身工具面的限制机制待 Phase 2 前专项验证（见 docs 勘误 E20）。
