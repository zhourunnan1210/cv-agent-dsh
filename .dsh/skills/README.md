# 本地 skills（`.dsh/skills/`）

本目录是**项目级 skill 根**：`@deepseek-ai/dsh-skill-filesystem` 的发现顺序里
`<projectRoot>/.dsh/skills` 位于 rank 100（项目根取最近的含 `.git` 的祖先目录）。
被发现的是**扫描根直接子目录**里的 `SKILL.md`，即 `<name>/SKILL.md`——嵌套的
`**/SKILL.md` 是**故意不被发现**的，所以归档时不要把上游仓库整棵拷进来。
没有 `SKILL.md` 的目录是纯资源目录（被其它 skill 以相对路径引用），不会被当成 skill。

## 一览

| 来源 | 本目录下的条目 | 可发现的 skill | 许可 | 基准提交 | 需要 dsh 适配 |
| --- | --- | --- | --- | --- | --- |
| [CCFA-Skills](https://github.com/mikubaka88/CCFA-Skills) | `ccf-*/`（18 个，含资源目录 `ccf-latex-templates`） | 17 | **MIT** | `383f4c4`（2026-09-16） | 否 |
| [nature-skills](https://github.com/Yuan1z0825/nature-skills) | `nature-*/` + `_shared/`（16 个） | 15 | **Apache-2.0** | `c91df24`（2026-07-02） | **是**（1 个文件） |
| [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | `academic-*/` + `shared/`（5 个） | 4 | ⚠️ **CC BY-NC 4.0** | `7f97a73`（2026-05-19） | **是**（5 个文件） |

合计 **36 个可发现 skill + 3 个纯资源目录**（`ccf-latex-templates`、`shared`、`_shared`）。

> 📦 **`paper-fetch` 已不在此目录**：2026-09-16 迁入插件包
> [`packages/dsh-plugin/skills/paper-fetch/`](../../packages/dsh-plugin/skills/README.md)，
> 使其随 `cv-agent-dsh` 分发。它的修改登记也随迁到那边的 README。

> ⚠️ **许可提示：`academic-research-skills` 是 CC BY-NC 4.0（署名—非商业性使用）。**
> 它是 BY-NC 而非 BY-NC-ND，因此**允许演绎**（本目录的适配修改不违规）。
>
> **决策记录（2026-09-16）：本项目为个人开发、明确不作商业使用**，非商业条款在
> 使用侧得到满足，`academic-*` 与 `shared/` 予以保留。
>
> **仍然存在的边界**：本仓库整体是 MIT，MIT 允许下游商业使用——两者不能混同。
> **不得把 `academic-*/` 与 `shared/` 的内容按 MIT 条款对外分发**；若日后开源发布
> 或商业化，必须先行移除这两部分。CCFA（MIT）与 nature（Apache-2.0）无此限制。

---

## 一、CCFA-Skills（MIT，**零适配**）

为 CCF-A 会议体裁而生的 skill 家族，是本项目论文写作与绘图的主力工具包。
17 个 skill 的家族控制文件在 `ccf-common/references/`，各 skill 以 `../ccf-common/…`
相对引用——**因此 `ccf-common` 必须与它们同级共存**，不可单独移动。

它的 frontmatter 形态（`name` + 短 `description` + `metadata`）与 dsh 的解析器天然对齐，
**未做任何修改**。核心条目：

| skill | 用途 |
| --- | --- |
| `ccf-paper-writer` | 起草 / 改写 / 润色 / 压缩正文 |
| `ccf-humanization` | 去防御性表达、机械枚举、过度破折号 |
| `ccf-visual-composer` | 数值图 / 视觉表格 / 方法架构图；纯 SVG 与可编辑 SVG / PDF / PPTX |
| `ccf-integrity-auditor` | claim / 数字 / 术语 / 引用一致性核验（BibTeX / context 检查） |
| `ccf-submission-checker` | 模板 / 页数 / 匿名 / PDF / 元数据 / 可复现件检查 |
| `ccf-experiment-designer` | 主实验 / 消融 / 鲁棒性与结果表证据结构 |
| `ccf-latex-templates/` | 会议 LaTeX 模板（**含 CVPR**、AAAI、ACL、ACM-MM、CHI 等），纯资源目录 |

用法是**按场景选择性调用**：`ccf-common` 负责家族路由，其它 16 个各司其职，
不需要一次全部加载。dsh 会把每个 skill 的 description 注入每个请求，因此
「按需点名」比「全量套用」更省上下文。

---

## 二、nature-skills（Apache-2.0）

15 个 skill，工程化程度最高：每个 skill 拆成 static（可复用片段）与 dynamic
（`manifest.yaml` + 路由）两层，按需加载。体裁是**期刊论文**（Nature 系），
与本项目的会议体裁不完全对口，但 `nature-figure`、`nature-citation`、
`nature-reader` 等有独立价值。

**对上游源码的修改：**

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `nature-downloader/SKILL.md` | `.claude/skills` / `.claude\skills\` 路径一律改为 `.dsh/skills`；兼容性说明改写为 dsh 的安装根 | dsh 的 skill 根与 Claude Code 不同 |

**一处命名不一致（上游如此，未改）**：目录 `nature-proposal-writer/` 的 frontmatter
自报 `name: researchwrite`。dsh 按目录发现、按 frontmatter 命名，因此它在技能目录里
显示为 `researchwrite`。这是上游的写法，保留原样以免升级时冲突。

**跨目录依赖**：多个 skill 引用 `../_shared/`，因此 `_shared/` 必须与它们同级共存。

---

## 三、academic-research-skills（CC BY-NC 4.0）

4 个 skill，重编排型（`academic-paper` 是"12-agent pipeline"，`deep-research` 是
"13-agent pipeline"，`academic-pipeline` 是端到端 10 阶段编排）。上游是一个
**Claude Code 插件**，仓库里还有 `commands/`、`hooks/`、`agents/`、`.claude/`、
`tests/` 等插件设施——**这些没有、也不打算移植**：dsh 没有斜杠命令与 hook 系统。
装进来的只有 4 个 skill 与它们依赖的 `shared/`。

**对上游源码的修改（共 6 个文件）：**

| 文件 | 修改 | 原因 |
| --- | --- | --- |
| `academic-paper/SKILL.md` | ① 移除对宿主级 `.claude/CLAUDE.md` 路由规则的引用（保留仓库内的 `shared/references/intent_clarification_protocol.md`）；② `/ars-<mode>` 斜杠命令 → "用户用自然语言点名模式" | dsh 无宿主级 CLAUDE.md、无 skill 斜杠命令 |
| `academic-paper-reviewer/SKILL.md` | 同上两处 | 同上 |
| `academic-pipeline/SKILL.md` | 同上两处 | 同上 |
| `deep-research/SKILL.md` | 同上两处 | 同上 |
| `shared/agents/compliance_agent.md` | Claude 的 `Agent tool` + `model: sonnet` 下限 → dsh 的 `subagent` 工具及其模型选择参数 | 工具名与调用形态不同 |

每处修改都在原文位置留了 `（dsh 适配：…）` 说明，便于日后与上游比对。

---

## dsh 化适配总则

改的是**引用了本运行时不存在的能力**的地方，不动写作/绘图/评审的逻辑本身：

| 上游写法 | dsh 对应 | 处理 |
| --- | --- | --- |
| `.claude/CLAUDE.md` 宿主路由规则 | 无 | 删除引用，保留仓库内协议文件 |
| `/skill-command` 斜杠命令 | 无 | 改为自然语言点名 |
| Claude `Agent tool` / `Task tool` / `subagent_type` | `subagent` / `subagent_fork` 工具 | 替换工具名 |
| `.claude/skills/<path>` | `<项目根>/.dsh/skills/<path>` | 替换路径 |
| `allowed-tools` 声明 | dsh 不解析该字段 | 无需处理（实测 0 处命中） |
| `.claude-plugin/`、`commands/`、`hooks/`、`agents/` | 无对应物 | **不移植** |

---

## 已知能力缺口（skill 在，但它依赖的东西不在）

这些不是适配问题，是**能力缺失**，用到时会明显不工作，先记录在此：

| skill | 缺什么 | 影响 |
| --- | --- | --- |
| `nature-academic-search` | 需要 PubMed / CrossRef / arXiv / Scopus / ScienceDirect 的 MCP server | 当前只装了 Asta MCP（Semantic Scholar）。它的多源检索用不了；检索请走 Asta |
| `nature-downloader` | 依赖同级 skill `web-access-main` 与 `sjtu-literature-downloader`（未安装），且需要已登录的 Chrome 会话 | 无法运行；下载请走 `paper-fetch` |
| `nature-experiment-log` | 需要飞书 CLI + Obsidian vault | 非本栈，无法运行 |
| `nature-literature-pipeline` | 需要飞书 / Telegram + cron 调度 | 定时部分无法运行 |
| `nature-figure` | 需要 Python 或 R，**R 本机未安装** | 只能走 Python 后端（matplotlib / seaborn 均已就位） |
| `nature-citation` | 期刊范围硬编码为 Nature Portfolio / Science 系 / Cell Press，后端是 Crossref | **对 CCF-A 会议是错靶子**；配引用请用 `ccf-integrity-auditor` 核验 + 人工组装 |
| `ccf-visual-composer` | GPT Image 2 路线需要图像生成工具 | dsh 无内置图像生成（`sci_draw` 随 ai4scholar 移除）→ **只能用纯 SVG 路线**，它显式支持 |
| `academic-*` 4 个 | 上游的 `commands/`、`hooks/`、`agents/` 未移植 | 12/13-agent pipeline 的编排要靠模型自己用 dsh 的 `subagent` 完成 |

**本机绘图/排版工具链实测**（2026-09-16）：Python 3.13.6 ✅、matplotlib 3.11.0 ✅、
numpy ✅、**pandas 3.0.5 ✅**、**seaborn 0.13.2 ✅**、python-pptx ✅、PIL ✅、PyYAML ✅；
pdflatex / xelatex / latexmk / pandoc ✅；**R ❌ 未安装**。

> 安装提示：pip 必须写 Python 的 site-packages 与 `%LOCALAPPDATA%\pip\cache`，
> 二者都在工作区之外——**在受限文件策略下 pip 会空转或失败**（实测：不报清晰错误，
> 只是长时间无输出）。装 Python 包需要更宽的权限。

---

## 升级上游的纪律

1. 上游更新后，**必须重新施加**上表的每一处修改（CCFA 无需）；
2. 在「一览」表里更新基准提交号；
3. 重新确认许可未变（尤其 `academic-research-skills` 的 CC BY-NC）；
4. 改完执行一次发现验证：确认 skill 仍出现在 dsh 技能目录里（本项目已有先例：
   frontmatter 写坏会让整个 skill 被静默丢弃）。
