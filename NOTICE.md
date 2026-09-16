# 第三方组件与许可合规

本仓库包含复制自上游的第三方代码。依 v1.2 文档 §11「许可合规」要求，各上游的 LICENSE 与版权声明一律保留在原位，不做修改。

## 直接收录（vendored）

| 组件 | 位置 | 版本 | 许可 | 上游 | 说明 |
| --- | --- | --- | --- | --- | --- |
| dsh-ai4scholar | `packages/vendor/dsh-ai4scholar/` | 0.3.7（基准提交 `27a026f`，2026-09-11） | MIT | https://github.com/literaf/dsh-ai4scholar | 学术检索 / 全文读取 / `auto_cite` / `sci_draw`，38 个工具。**已于 2026-09-16 从 web profile 的 bundle 列表停用**（改用 Asta MCP，见下），源码与 LICENSE 仍保留在本仓库备查，不再装载。上游 `LICENSE` 原件保留在该目录内。 |
| paper-fetch | `.dsh/skills/paper-fetch/` | 基准提交 `8e329aa`，2026-09-16 | MIT | https://github.com/Agents365-ai/paper-fetch | DOI / 标题 → PDF（七源回退）。作为项目级 skill 被 dsh 发现，补上 Asta 没有的全文获取能力。**本仓库对上游做了两处修改**（Sci-Hub 默认关闭），逐条登记在 `.dsh/skills/README.md`。上游 `LICENSE` 原件保留在该目录内。 |
| CCFA-Skills | `.dsh/skills/ccf-*/` | 基准提交 `383f4c4`，2026-09-16 | MIT | https://github.com/mikubaka88/CCFA-Skills | CCF-A 会议体裁的写作 / 绘图 / 评审 / 投稿 skill 家族：17 个 skill + `ccf-latex-templates`（含 CVPR 等会议模板，纯资源目录）。**未修改上游源码。** |
| nature-skills | `.dsh/skills/nature-*/` + `_shared/` | 基准提交 `c91df24`，2026-07-02 | Apache-2.0 | https://github.com/Yuan1z0825/nature-skills | 期刊论文工作流，15 个 skill。**修改 1 个文件**（`nature-downloader/SKILL.md` 的 `.claude/skills` 路径改为 `.dsh/skills`），登记在 `.dsh/skills/README.md`。 |
| academic-research-skills | `.dsh/skills/academic-*/` + `shared/` | 基准提交 `7f97a73`，2026-05-19 | ⚠️ **CC BY-NC 4.0** | https://github.com/Imbad0202/academic-research-skills | 4 个编排型 skill（12/13-agent pipeline）。**修改 6 个文件**（移除 Claude 专有的宿主路由、斜杠命令与 Agent tool 引用）。上游是一个 Claude Code 插件，其 `commands/`、`hooks/`、`agents/`、`.claude/` **未移植**。 |

> 上述目录内的源码与 `LICENSE` 为上游原文；本仓库对其的任何修改必须逐条登记
> （`packages/vendor/README.md` / `.dsh/skills/README.md`），并保留上游版权声明。

> ⚠️ **许可边界（已裁定）**：`academic-research-skills` 采用 **CC BY-NC 4.0**
> （署名—非商业性使用）。它是 BY-NC 而非 BY-NC-ND，**允许演绎**，因此本仓库对它
> 的 6 处 dsh 适配修改不违规。
>
> **决策记录（2026-09-16）：本项目为个人开发、明确不作商业使用**，非商业条款在
> 使用侧得到满足，`academic-*` 与 `shared/` 予以保留。
>
> **仍然存在的边界**：本仓库整体以 MIT 授权（`LICENSE`），而 MIT 允许下游商业
> 使用——两者不能混同。**不得把 `.dsh/skills/academic-*/` 与 `.dsh/skills/shared/`
> 的内容按 MIT 条款对外分发**。若日后开源发布或商业化，必须先行移除这两部分。
> CCFA-Skills（MIT）与 nature-skills（Apache-2.0）无此限制。

## 运行时依赖（未复制源码，由包管理器安装）

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| @deepseek-ai/dsh（含 Cordis 及各 `dsh-*` 包） | MIT | Agent 运行时底座。学术检索经其自带的 `dsh-mcp-client` 桥接 MCP |
| @deepseek-ai/schemastery | MIT | 配置 Schema |

> MinerU 已决定**只走官方 API**，因此它不是运行时依赖（不由包管理器安装），
> 只作为外部数据服务列在下表。

## 外部数据服务（非依赖，凭密钥访问）

| 服务 | 用途 | 备注 |
| --- | --- | --- |
| Asta MCP（Ai2，`asta-tools.allen.ai`） | 学术检索：Semantic Scholar 图谱的检索 / 引用 / 作者 / 正文片段 | 经 `x-api-key` 鉴权；遵守其 ToS 与速率限制 |
| MinerU API（mineru.net，上海 AI 实验室） | PDF → Markdown / JSON 深度解析 | 额度 **2000 页/天**最高优先级（超出降优先级）；限流与端点见 `docs/mineru-api.md`。**上传的 PDF 会离开本机，敏感材料不要送** |
| Unpaywall / Semantic Scholar / arXiv / PubMed Central / bioRxiv / medRxiv | 开放获取 PDF 解析 | 免费源，须遵守各自 rate limit 与 ToS |

## 合规红线（摘自 v1.2 §23，工程上必须强制）

1. **论文版权**：仅自动下载开放获取（OA）PDF。非 OA 论文只落盘元数据与摘要，PDF 由用户自行获取后放入 `pdfs/`。**Agent 不做绕过付费墙的抓取。**
   - 工程落实：`paper-fetch` 的 Sci-Hub 兜底**默认已关闭**（`PAPER_FETCH_ALLOW_SCIHUB` 未设为 `1` 即不启用），机构模式（`PAPER_FETCH_INSTITUTIONAL`）与 CloakBrowser（`PAPER_FETCH_CLOAK`）同样默认关闭。见 `.dsh/skills/README.md`。
2. **数据集协议**：FF++、DFDC 等需签署使用协议的数据集由用户本人申请与下载；Agent 只接收已授权的本地路径，不代为申请。
3. **API 合规**：遵守 Asta / Semantic Scholar / arXiv / Unpaywall / MinerU 的 rate limit 与 ToS。
4. **密钥卫生**：所有 API key 走 dsh credentials wire API、环境变量或本地 `.env`（已 gitignore）。**密钥字面值不进入模型上下文、不写入日志、不进入 git。**（`ASTA_API_KEY`、`MINERU_TOKEN` 均按此处理，组合文件里只写 `!!js process.env.*`。）
5. **学术诚信**：论文草稿中的引用必须来自 Asta（`mcp__asta__*`）的真实检索结果，**禁止模型凭记忆生成引用**；材料包中的所有指标必须可溯源到具体实验运行记录（`exp_id`）。
   - ⚠️ 注意：随着 `auto_cite` 一并移除，当前**没有**自动插入引用与生成 BibTeX 的工具。写作阶段的引用组装需要重新设计（手工引用 + 校验，或引入替代工具），此缺口未关闭。
