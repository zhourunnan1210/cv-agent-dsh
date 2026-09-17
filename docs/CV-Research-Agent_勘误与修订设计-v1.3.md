# CV-Research-Agent 开发文档 —— 勘误与修订版设计（v1.3-draft）

| 项目 | 内容 |
| --- | --- |
| 文档性质 | 对 `CV-Research-Agent_开发文档.md` v1.2 的勘误与修订，**不是全文重写** |
| 勘误依据 | 对本机实际安装的 dsh `0.1.5-rc.1` 运行时逐项核实（方法见 §1） |
| 修订范围 | §3.2、§3.3、§4.2、§5.1、§9.2、§15、§16.1、§20、§22 |
| 状态 | 待评审冻结。本文件定稿前，**不要按 v1.2 的 §16.1 写代码** |
| 生成时间 | 本文件由 Phase 0 的 dsh 侧验证产出 |

---

## 1. 核实方法（证据分级）

本文件区分三类结论，每条论断都标注了级别。请勿把 L2/L3 当作 L1 使用。

| 级别 | 含义 | 可复现方式 |
| --- | --- | --- |
| **L1 实证** | 已在本机真实运行并得到输出 | 命令/脚本随文附出，可重跑 |
| **L2 契约** | 来自已安装运行时包的类型声明、导出源码与官方注释 | 读 `node_modules/@deepseek-ai/*` 对应文件 |
| **L3 推断** | 由 L1/L2 推出，尚未实跑 | 需在后续 Spike 或主机重启后确认 |

核实环境（L1）：Node `v24.19.0`、dsh `0.1.5-rc.1`、pnpm `12.4.2`、Windows、Web GUI 运行于 `127.0.0.1:3080`。

**L1 实证脚本**（均驱动真实运行时，非 mock）：

| 脚本 | 证明什么 |
| --- | --- |
| `tests/smoke-vendor-plugin.mjs` | 基座插件 38 个工具全部注册，参数 Schema 与渲染器齐备 |
| `tests/spike-s1-tool-isolation.mjs` | 工具白名单隔离在 `ToolRuntime` + `dsh-scope` 层有效（12 条断言） |

---

## 2. 勘误总表

| # | v1.2 原文位置 | 原文主张 | 核实结论 | 级别 | 处置 |
| --- | --- | --- | --- | --- | --- |
| E1 | §3.2-1、§16.1 | 定义 ≥5 个 Agent Preset，靠 preset 差异实现各角色工具白名单隔离 | **不成立**。子 Agent 继承父 Agent 的同一份 standing composition，preset 由父作用域绑定，子代理无法挂另一份 preset | L2 | **改设计**，见 §4 |
| E2 | §5.1 检索能力 | 复用 `get_semantic_citations` / `get_semantic_references` / `get_semantic_recommendations` / `search_semantic_paper_match` | 全部真实存在，且 38 个工具全部注册成功 | **L1** | 保留 |
| E3 | §2.1 | dsh-ai4scholar 提供「38 个原生学术工具」 | 精确为 38（含 5 个 `download_*`、8 个 `read_*`） | **L1** | 保留 |
| E4 | §3.3、§11 | 「复制 dsh-ai4scholar 代码」入库 | 源码仓库**不含构建产物**（`lib/` 被上游 gitignore），复制后必须 `pnpm install`（触发 `prepare` 构建）或显式 `pnpm run build`，否则插件无法加载 | **L1** | 已补入 §5 落地事实 |
| E5 | §10 末段 | 「通过 `ctx.tools` 的 `defineTool` 注册」 | 不精确。`defineTool()` 是 `@deepseek-ai/dsh-tools` 的**纯函数**，把声明编译为 `ToolDefinition`；真正注册是 `ctx.tools.register(defineTool({...}))`，返回 disposer | **L1**（跑错会直接 `TypeError: ctx.tools.register is not a function`） | 修正表述 |
| E6 | §3.2-4、§16.2 | 工具 Schema 与 prompt 章节「以 effect 安装，可预测回退」 | 成立，且有更强能力：`ctx.systemPrompt.section()` 注册的是**作用域内有序章节**，改动触发 `system-prompt/change` 并在**每次模型步之前重新组装** | L2 | **增强设计**，见 §4.5 |
| E7 | §4.2 | 「每次会话开始，主 Agent 通过 dsh 交互界面呈现模式选择」 | dsh **没有**通用"启动时询问"机制；呈现必须由我们自己实现（工具 + 落盘待决状态） | L2 + L3 | 见 §5 待定项 S6 |
| E8 | §15.1 | `cvagent.gate.request` 返回 `{decision, comment?}`，「A 模式阻塞」 | 「阻塞等待用户」不能实现为一个工具调用；必须分解为「落盘 gate 状态 → 呈递 → 下一轮读取决定」 | L2 | 见 §5 待定项 S6 |
| E9 | §4.2 / §20 | C 模式预算上限、超限自动降级 B | 计量来源已确认存在（`TokenUsage`：input/output/cacheRead/cacheWrite/reasoning），但**配额与降级逻辑需自建**，dsh 无现成预算服务 | L2 | 见 §5 待定项 |
| E10 | §3.2-2 | 三库/打分等服务注册为 Cordis Service | 可行，但**服务行不得裸放在 preset 里**：会落入进程全局 realm，第二个会话挂同一 preset 即冲突。preset 自有服务必须包在带 `isolate` realm 的 group 内 | L2 | 见 §4.4 |
| E11 | §2.2 / §12 | Phase 0 六个 Spike | 与实际情况一致，但 S1/S2/S6 的**问题提法需要改写**（v1.2 问的是"能不能"，实际答案是"用哪个机制"） | L2/L3 | 见 §5 |
| E12 | 仓库根目录 | 仓库名 `cv-research-agent` | 实际工作区目录为 `D:\Code\VScodeRepo\dsh-plugin`（目录名早于项目命名）。已按用户决定：**目录名保留，仓库身份为 `cv-research-agent`** | L1 | 记录备案 |
| E13 | §16.1 隔离红线的保障方式 | 靠 preset 定义正确来保证 Orchestrator 看不到重上下文工具 | 实际由 **runtime 双重兜底**：`restrict()` 无 scope 时直接抛错；过滤器含未知工具名时抛错并列出已知工具。红线不是"我们写对才有" | **L1** | 见 §5.1 |
| E14 | （初稿遗漏）委派参数的下发时机 | — | `toolFilter` 必须使用**已注册的真实工具名**，否则 `restrict()` 在委派时抛错。Phase 1 的工具命名因此需要一份稳定的常量表，不能散落字符串字面量 | **L1** | 见 §4.1、§5.1 |
| E15 | §7.2 / §4.2（未提及） | 隐含假设：实验子代理可在运行中请求授权（如启动云 GPU） | **不成立**。委派时子代理的审批策略被硬性钉为 `'never'`（`captureDelegatedPolicyOverrides`），与父策略无关。子代理只能做父已授权的事，**不能中途发起审批** | L2 | **改设计**，见 §4.6 |
| E16 | （工程细节，两份文档均未涉及） | — | Cordis 插件装载有两个易错形态：① `dsh-system-prompt` 的 default 导出是**插件类**，必须直接传给 `ctx.plugin()`；拆成 `{ name, apply }` 普通对象会被拒绝（`invalid plugin ... received object`）；② 嵌套插件必须在父插件的 `apply` 内 **await**，否则子插件尚未激活就返回，外部读到的是 `undefined` | **L1**（两次失败实测） | 见 §5.3.1 |
| E17 | （工程细节，未涉及） | — | **解构丢失 this 绑定**：`const { register } = ctx.tools; register(...)` 会让 `this.layers` 未定义（ToolRuntime 的 register 依赖实例字段）；必须保留 `ctx.tools.register(...)` 方法调用形态 | **L1**（三次失败实测后定位） | 见 §5.3.1 |
| E18 | （工程细节，未涉及） | — | ① schemastery 默认值只在 Loader 按 Config schema 校验时注入；直接 `new` 构造时字段是 `undefined`，`JSON.stringify` 会**静默丢弃**（project_id 缺失被形状校验拦下）——构造器必须显式解析默认值；② loader 装载的行模块必须有 `default`（插件类）或命名 `apply` 导出，只有命名导出会被拒 | **L1**（隔离 profile 实机装载实测） | 见 §5.3.1 |
| E19 | （工程细节，未涉及） | — | preset 组合里**不带 config 的行**，Loader 传入的 config 是 `undefined`，schemastery 的 `.default()` 在该路径**不生效**（mount-validate 报 `Cannot read properties of undefined (reading 'projectDir')`）——构造器必须 `config = {}` + `?.` 显式取默认值 | **L1**（mount-validate 实测） | 见 §5.3.2 |
| E20 | §16.1 角色矩阵 / §4.1 | 隐含假设：主 Agent 的工具面可以由 preset 组合裁剪（排除 `read_*` 等重上下文工具） | **部分不成立**：dsh-ai4scholar 是 profile 的 bundle 层（宿主平面），其 38 个工具对**所有** preset 全局可见，preset 组合无法移除它们。且主 Agent 的 setup 窗口由 `dsh-api-session-controller.composeAgent()` 硬编码（`mount` + `installSelection`，无第三方钩子），目录级 `restrict()` 对主 Agent **没有受支持的扩展点**。**已用执行级护栏解决**（`tools/pre-execute` waterfall + `agents.roots()` 区分根/子代理），见 §5.3.2 第 5 条 | L2（controller 源码级）+ **L1**（护栏 6 条测试） | **已闭环**（执行级） |
| E21 | （工程事实，未涉及） | — | **运行中的宿主进程缓存两样东西**：① 已加载的插件模块代码（Node module cache）；② 包根的 `package.json` exports 解析（新增子路径报 `Package subpath './x' is not defined by exports`，尽管磁盘上已有）。两者都不随文件 mtime 失效——**HMR 未启用时，插件的任何改动（含 exports 映射）都必须重启宿主**。三轮 mount-validate 反复命中同一条旧错误、磁盘修复全绿，实证了这一点 | **L1**（三轮实测） | 记录备案 |
| E22 | §5.1 检索能力（Asta 通道） | 隐含假设：`search_papers_by_relevance` 的 `limit` 生效，可按 limit 批量取论文 | **不成立**。实测（2026-09-17）该工具**忽略 `limit`**，无论传 5 还是 50 都只回**单篇**最佳匹配——它是「按关键词找那篇论文」，不是检索通道。**有量的通道是 `snippet_search`**（limit=100 → 100 条 snippet、覆盖 68 篇不同论文，`data[].paper` 给 corpusId/title/authors）。另有一条**渲染陷阱**：MCP 结果的 `content[0].text` **只渲染第一条记录**，完整数组在 `value.structuredContent.result` 里；只读 text 会把 500 条误当 1 条（`get_paper_batch` 同此）。见 §7.6 | **L1**（真实调用实测） | **改通道用法**：Scout 走 `snippet_search` 发现 + `get_paper_batch` 按 CorpusId 批量补元数据（fields 只用 `title,year,venue,externalIds`，带 `abstract` 会挂起，见 P2-5） |
| E23 | §8.1 MinerU 链路 | `docs/mineru-api.md` §4：提交任务类限流 300 次/分钟 | **文档口径偏松**。实测 `POST /file-urls/batch` 在数分钟内第 3 次提交即 **HTTP 429**（前两块上传各耗时约 1 分钟，绝非 300/分的量级），说明该端点有比公开表格更紧的频控 | **L1**（批量解析实测） | 提交层必须**退避重试 + 块间停顿**（5s→80s 指数退避，块间 6s）；`batch-parse.mjs` 已实现 |
| E24 | （工程细节，未涉及） | — | **paper_id 不能直接当路径**：Zotero 导入的 `local:...` 条目带 `:`，在 Windows 上是非法路径字符，`mkdir` 抛 `ENOENT` 并**直接崩掉整个批量进程**——一篇论文毁掉已提交的 106 篇进度。同理标题派生的 ID 可能超长（MAX_PATH）。**续发形态**：截断到 100 字符时若正好落在空格上，会生成「尾随空格目录名」——**Node 的 `statSync` 读得到，PowerShell / 资源管理器读不到**（`Get-ChildItem -Recurse` 直接报「找不到路径」），完整性检查因此全绿而用户实际打不开目录 | **L1**（批量解析 + 目录遍历双重实测） | 三条纪律：① 落盘目录走 `safeDirName()`（非法字符→`_`、逐段截断 100 字符**并去尾随空格/点**，DOI 的 `/` 保留以兼容既有布局），**DB 里的 `md_path` 才是契约**；② 逐篇 `try/catch`，单篇失败只标 `parse_channel='failed'`，不得终止整批；③ 完整性检查必须用**与用户相同的读取路径**（PowerShell）复核，不能只看 Node |
| E25 | （工程细节，未涉及） | — | 额度账本的公开面是 **`quota.status`**（`QuotaStatus{date,usedPages,limit,overHighPriority,warning}`），不是 `quota.usedPages` 直接属性；直接取会得到 `undefined` 并让预算门静默失效 | **L1** | 记录备案（`batch-parse.mjs` 已按 `quota.status` 取值） |
| E26 | §8.1 MinerU 链路 / 环境前置 | 隐含假设：MinerU 是「国内服务」，只要 `NO_PROXY` 里放了 `mineru.net` 就与代理无关 | **不成立**。MinerU 一条解析链路跨**三个**域名，漏掉后两个，代理一挂就在那一步全废，而 MinerU 侧其实已经解析完成：① API `mineru.net`；② **签名上传落在 `mineru.oss-cn-shanghai.aliyuncs.com`**（漏掉 → 上传 PUT `ECONNREFUSED 127.0.0.1:10808`）；③ **产物 zip 落在 `cdn-mineru.openxlab.org.cn`**（漏掉 → 7 篇全部「fetch failed」，而 batch 状态其实是 `done`）。**2026-09-17 实测**：清掉代理变量后 API 304ms、OSS PUT 249ms，均 HTTP 200——三个域名都无需代理 | **L1**（代理掉线期间实测，两条链路各命中一次） | `NO_PROXY` 必须含 `mineru.net,aliyuncs.com,openxlab.org.cn`（`scripts/start-dsh-web.ps1` 与各脚本默认值已同步）；新增 `batch-parse.mjs --resume-batch <id>` 做**定向补收**（MinerU 侧 done、本地未落库时的补救入口，不重复提交） |
| E27 | §2.1 MinerU 批量接口 | 用文件名对账（`extract_result[].file_name`） | 可用但**不必要地脆弱**：文件名要经过我们的 sanitize 与截断。实测 `extract_result[]` **原样回传提交时的 `data_id`**（2026-09-17）——它是我们自己给的业务标识，天然唯一、不受文件名规则影响 | **L1** | `MineruFileResult` 增 `dataId`；`batch-parse.mjs` 对账**优先 `data_id`、回退 `file_name`** |
| E28 | §5.4 环境前置 / `scripts/start-dsh-web.ps1` | 隐含假设：启动脚本「跑起来就能用」 | **中文 `.ps1` 无 BOM 在 Windows PowerShell 5.1 下必崩**。实测 2026-09-17（用户报「无法启动」）：根因是**编码而非逻辑**——PS 5.1 读无 BOM 的 `.ps1` 按 **ANSI/GBK** 解码，中文注释变乱码（`代理端口` → `浠ｇ悊绔彛`），乱码字节吃掉字符串引号 → **解析期报错，脚本一行都不执行**，且报错指向乱码位置、极难定位。本项目 shell 实测为 **5.1.26100**（不是 pwsh 7） | **L1** | ① 该文件加 **UTF-8 BOM** 并把「不许丢 BOM」写进文件头；② 新增护栏 `tests/ps1-encoding.test.ts`：扫描全仓 `.ps1`，**含非 ASCII 却无 BOM 即失败**（已用「去 BOM 失败 → 恢复通过」双向验证），并逐项钉住脚本必须注入的前置 |
| E29 | §5.4 环境前置 | 隐含假设：`dsh web` 直接启动与经脚本启动等价 | **不等价，且差值全是静默的**。实测 2026-09-17（用户以 `dsh web` 重启主机后）：宿主环境里 `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` / `CV_PROJECT_SKILLS_DIR` / `CV_PLUGIN_SKILLS_DIR` / `ASTA_API_KEY` / `MINERU_TOKEN` **全部未设置**。后果：preset 的 `mcp-asta` 行拿到 `x-api-key: UNSET` → **检索工具静默消失**；即使有 key，缺 `NODE_USE_ENV_PROXY=1` 也连不上（Node fetch 忽略 HTTPS_PROXY）；skill 根回落到相对路径（换工作区即失效）。**这些前置只能由宿主进程环境提供**，仓库里的配置文件补不上 | **L1** | 启动一律走 `scripts/start-dsh-web.ps1 -DryRun` 先自检（显式打印每一项 + skill 根是否存在 + 代理是否在监听 + Asta 连通预检），再正式启动 |
| E31 | §5.2 子代理委派 / §16.1 角色矩阵 | 隐含假设：自己抄一份 `SubagentLike { start(name, request: unknown) }` 就够了 | **`request: unknown` 让这次委派的每一个字段都逃过类型检查**，于是**必填**的 `signal` 被漏掉。实测 2026-09-17（用户在真实会话里 `cvagent_kb_scout` 连败 3 次）：`Error: Cannot read properties of undefined (reading 'aborted')`。抛出点是宿主 `dsh-subagent-in-process-driver` 的第一行 `if (request.signal.aborted) throw prePublicationAbort()`，而该文件 jsdoc 明写「the trusted typed start request, **including its required signal**」、真接口里 `readonly signal: AbortSignal`（非可选）。**这是本 session 第三次同族事故**（E30 的 inject、`instructions.test.ts` 的替声明）：自己重写对方的契约 → 没人能检查它 | **L1**（用户真实会话 3 连败） | ① 四个文件各抄的 `SubagentLike` 合并为 `src/subagent.ts` 一处声明，`signal` 必填，6 个调用点全部显式传 `exec.signal`；② `tests/subagent-contract.test.ts` 直接读**已安装的** `dsh-subagent/lib/types/types.d.ts`，要求本地镜像覆盖真接口的每个必填字段（宿主将来加必填字段会红），并静态要求每个 `subagents.start` 调用点带 `signal`、禁止再出现 `request: unknown` |
| E32 | §5.1 Scout 隔离红线 / §12.3 检索补全 | ① "Scout 不含 `snippet_search`"被当成红线本身；② Scout 的"缺省读项目状态"只写在**工具描述**里 | ① **白名单与委派 prompt 是一对必须同时成立的声明**：prompt 让子代理「先用 `mcp__asta__snippet_search` 发现（唯一有量的通道）」，白名单却把它剔掉——子代理一调用即被响亮拒绝（E14），整轮委派失败。而 `snippet_search` 恰恰是 Asta 族**唯一有量**的发现通道（`search_papers_by_relevance` 的 `limit` 不生效）；§5.1 红线的边界是**主编排上下文**，不是子代理的一次性上下文。② 用户实测：`cvagent_scope_set` 早已落盘（`scope_ready: true`），Scout 仍报「请先 cvagent_scope_set」——因为实现只认入参，"缺省读状态"从未实现 | **L1**（用户真实会话） | ① `SCOUT_ALLOWED_TOOLS` 加入 `snippet_search`（共 8 个），主编排侧隔离仍由 `ORCHESTRATOR_DENY_TOOLS` + E20 护栏守；② Scout 经 `ctx.get('projectState')` 读已落盘范围，入参优先、**两边都空**才报错，输出加 `scope_source: args/state` 让口径来源可见；③ 回归断言：prompt 里推荐的每个 `mcp__asta__*` 都必须在白名单内（这正是出事点） |

---

## 3. L1 实证记录（可复现）

### 3.1 环境前置（原文档缺失的工程前置）

```
node -v          → v24.19.0                 ✅ 满足 §11 要求
dsh              → 0.1.5-rc.1（Web UI 运行中）
pnpm             → 安装前 NOT FOUND → 安装后 12.4.2
```

**两个必须写入 §11 的环境事实**：

1. **pnpm 是硬前置**。`dsh plugin --profile <name> <args>` 是"thin pnpm forwarder"：它初始化 profile、在 profile 目录执行 `pnpm <args>`、再按安装态回填 `dsh.profile.bundles`。pnpm 不在 PATH 时报 `pnpm not found on PATH — install pnpm to manage profile plugins` 并返回 **127**。
2. **sandbox 会拦住两类 dsh 常规操作**（本机 `workspace-write` 策略下实测）：
   - `npm install -g`：写 `%LOCALAPPDATA%\npm-cache` 被拒（EPERM）；
   - `dsh plugin add`：在 `$DSH_HOME/profiles/<name>/node_modules` 建符号链接被拒（os error 5）。

   两者都在工作区之外，需要提权审批。**建议**：把"安装/链接插件"列为显式的、需要审批的工程步骤，不要假设它能静默完成。另外 pnpm 自身的 `global-dir`/`state-dir` 也需指到工作区内（已在仓库 `.npmrc` 落实）。

### 3.2 基座插件（dsh-ai4scholar）落位与验证

| 步骤 | 结果 |
| --- | --- |
| `git clone --depth 1` 到 `packages/vendor/dsh-ai4scholar` | ✅ 版本 `0.3.7`，MIT |
| 克隆后 `lib/` 是否存在 | ❌ **不存在**（上游 `.gitignore` 排除，`files` 只发布 `lib`） |
| `pnpm install`（根 workspace） | ✅ 自动触发该包的 `prepare` → `tsc` + `tsdown`，产出 `lib/index.js`、`lib/client.js`（38.33 kB） |
| 链入 web profile | ✅ `dsh plugin --profile web add link:D:\...\dsh-ai4scholar`，`dsh.profile.bundles` 自动追加 `dsh-ai4scholar` |
| 工具注册实证 | ✅ 见下 |

验证脚本 `tests/smoke-vendor-plugin.mjs` 用最小假上下文驱动真实构建产物（`apply(ctx, config)`），结果：

```json
{
  "pluginName": "ai4scholar",
  "declaredInject": ["tools", "systemPrompt"],
  "toolCount": 38,
  "toolsWithParameterSchema": 38,
  "toolsWithRenderer": 38,
  "promptSections": 1,
  "commandsRegistered": 0
}
```

关键结论：**38 个工具、38 个参数 Schema、38 个渲染器、1 个 prompt 章节**，与文档 §2.1 的"38 个原生学术工具"完全吻合。文档 §5.1 点名要用的 4 个工具全部在册：

- `get_semantic_citations`、`get_semantic_references`（引用图追踪）
- `get_semantic_recommendations`、`get_semantic_recommendations_for_paper`（推荐发现）
- `search_semantic_paper_match`（本地百篇论文的标题匹配补全，§5.1 用户约束依赖它）

> ⚠️ 未验证项：网络可达性与 ai4scholar.net 计费额度。该 smoke 测试不发起任何网络请求；密钥通过 `ctx.credentials` 惰性解析，本测试中恒为 `undefined`。这不影响"工具面正确"的结论，但 §20 的成本模型仍需真实调用才能标定。

---

## 4. 修订版设计

### 4.1 【E1 核心修订】子代理隔离改用「委派时约束」，不用多 Preset

**v1.2 的错误假设**：定义 Orchestrator / Scout / Reader / Analyst / Writing 五个 preset，靠 preset 的工具差异实现隔离。

**实际机制**（L2，源码注释原文可查）：

> `composeFrom(agentCtx, parentCtx)`: "Join one agent to the SAME standing composition another already runs on. **This is how a child agent inherits its parent's capabilities.** It is a bind, not a mount: the parent's generation is already composed, so the child gets that exact instance — the same plugin objects, the same tool registrations, the same prompt sections."

子代理在**同步的创建窗口**内继承父代理的组合，因此预设是"会话级"的，无法用于区分子代理角色。

**正确机制**：`SubagentStartRequest` 本身携带三项按次生效的约束，且 `spawn` provider 全部支持（L2，`dsh-subagent-spawn-in-process` 能力表）：

```ts
export interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions        // { provider, model, reasoningEffort, maxTokens }
  readonly outputSchema?: ObjectJsonSchema    // 强制结构化返回
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction       // { allow?: string[], deny?: string[] }
  readonly persona?: string
}

// dsh-subagent-spawn-in-process:
capabilities = { agentOptions: true, outputSchema: ..., depthLimit: ..., toolFilter: true, persona: true }
```

**收益优于原设计**：

1. **隔离更彻底**。原设计靠"5 个 preset 各挂一套工具"来近似隔离；现在每次委派都显式声明 `toolFilter`，Orchestrator 那条"工具白名单中没有全文读取与代码执行能力"的红线，是在**委派参数**上封死的，不依赖 preset 定义是否写对。
2. **模型分档天然落地**。§16.1 的"轻量档 / 中档 / 高档"直接映射 `agentOptions: { provider, model, reasoningEffort }`——这本来就是它的用途。
3. **结构化返回有强制力**。`outputSchema` 让"子 Agent 只回传结构化 JSON、不回传全文"从 prompt 约定升级为运行时约束，正对 §9.4 的上下文预算表。
4. **不需要维护 5 份组合文件**，也就没有 5 份组合文件各自漂移的风险。

**Preset 的正确用途**（保留，但重新定义）：用于**用户以不同身份开新会话**，例如

| Preset id | 用途 | 与子代理的区别 |
| --- | --- | --- |
| `cv-research` | 主编排会话（默认） | 这是"人开的会话" |
| `cv-write` | 纯写作会话：只挂材料包读写 + `auto_cite` / `sci_draw`，不挂检索与实验工具 | 用户想专注写作时开这个会话 |
| `cv-kb` | 纯知识构建会话：只挂检索 + 三库工具 | 批量文献整理时开这个会话 |

即：preset 表达**会话的能力边界**，`toolFilter` 表达**一次委派的能力边界**。两者正交，不再混用。

### 4.2 修订版 §16.1：角色矩阵（按委派参数而非 preset）

| 角色 | `toolFilter.allow`（委派时声明） | `agentOptions.model` | `outputSchema` | 上下文预算 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Orchestrator（主 Agent） | 会话级 preset 决定，**本身无 `kb.extract`、无代码执行** | 高档 | — | ≤ 30k | 唯一持有全局状态；红线在 preset 工具面 |
| Scout | `search_*`、`get_semantic_*`、`download_*` | 轻量 | 候选列表数组 | ≤ 15k | 只回传候选列表 |
| Reader | 无工具（输入即单篇 Markdown），或仅 `read_*_paper` | 轻量 | `PaperExtraction` | 单篇 ≤ 60k | 一次一篇，完成即释放 |
| Analyst | `kb.upsert_entry`、`kb.search` | 中档 | 三库变更摘要 | ≤ 40k | 去重合并判断 |
| Train / Eval / Repro | 代码执行 + 文件读写（沙箱内） | 中档 | 指标摘要 | ≤ 40k | 只回传指标 |
| Writing | 无检索工具，可读材料包；引用经 `auto_cite` | 高档 | 章节草稿 | ≤ 50k | 不接触实验中间文件 |

> 注：`toolFilter` 的 `allow` 是**白名单**，与 v1.2 表格中的"可用工具"列语义一致，只是载体从 preset 换成委派参数。这张表是 Phase 1 落地 `cvagent` 委派封装函数的直接输入。

### 4.3 修订版 §4.2：模式与门控（门控不再是"阻塞工具"）

**问题**：`cvagent.gate.request` 在 v1.2 里被描述为"向用户呈现阶段摘要并等待选择；A 模式阻塞"。工具调用无法在单次执行内等待用户输入，这是模型-工具协议的结构性限制，不是实现细节。

**修订设计**：把 gate 拆成**三段式**，全部围绕状态文件：

```
① 阶段出口判定（主 Agent 调用 cvagent.state.advance）
   → 校验 §9.3 完成判据
   → 达标则写 project_state.json: { stage, status: 'awaiting_gate', gate: { summary, options } }
   → 返回 { stage, gate_result: 'pending', missing: [...] }

② 呈递（同一轮内，主 Agent 调用 ask_user_question，或直接以自然语言 + present 呈递摘要）
   → 这是合法的"阻塞点"：ask_user_question 就是为这个设计的
   → 注意：exit_plan_mode 生效期间 ask_user_question 会被禁用，两者不要混用

③ 决议落盘（用户答复作为下一轮输入）
   → 主 Agent 调用 cvagent.gate.resolve({ decision, comment })
   → 写 project_state.json，清除 gate，按模式决定是否 advance
```

**三种模式的差异只落在第 ② 步**：

| 模式 | 第 ① 步 | 第 ② 步 | 第 ③ 步 |
| --- | --- | --- | --- |
| A 确认 | 写 gate | 必须 `ask_user_question` 呈递并等待 | 用户答复后才推进 |
| B 监督 | 写 gate（不阻塞） | 不主动询问；在阶段摘要中列出 gate 与回滚点，用户可主动介入 | 自动推进，保留快照 |
| C 无人值守 | 写 gate（自动放行） | 不询问，记入报告 | 自动推进；仅在 §4.2 安全边界（计费 API、破坏性文件操作、启动 GPU）处降级为 B |

**这一改动同时解决了"启动时询问模式"**（E7）：不做"会话启动拦截"，而是把模式作为 `project_state.json` 的字段，并提供一个 `cvagent.mode.set` 工具 + 一个 scoped prompt 章节（见 §4.5）。会话开始时主 Agent 读取状态文件，若 `mode` 为空则用 `ask_user_question` 问一次并落盘。**dsh 没有会话启动钩子，不要试图实现它。**

### 4.4 【E10】服务行必须落在 isolate realm

任何发布 Cordis Service 的行（`kb` / `ideaScore` / `expOrchestrator` / `projectState`），如果放在 preset 里，**必须**包在带 `isolate` 的 group 内：

```yaml
- id: cvagent-services
  name: cordis:group
  group: true
  isolate:
    kb: true
    ideaScore: true
    expOrchestrator: true
    projectState: true
  config:
    - id: cvagent-kb
      name: cv-agent-dsh/kb
    # ... 全部消费者也必须在同一个 group 内
```

原因：不包 realm 就落到进程全局 realm，第二个会话挂同一 preset 会撞名；而**消费者若留在 group 之外，会解析到宿主未填充的注册表，导致该行永不激活**。

**更重要的判断**：如果 `kb` 等服务的消费者在 agent 平面之外（例如浏览器 RPC 要读三库计数、宿主层要读项目状态），那么**它们属于宿主组合，不属于 preset**。Phase 1 必须先做这个判定——这决定了这些服务的落位，改起来代价很大。

#### 4.4.1 归属判定分析（待你确认）

判定依据是**同一时刻是否可能存在两个不同实例**。若两个会话可能同时处理不同项目，
那么"每个项目一份"的服务就不能是进程单例。

| 服务 | 数据归属 | 是否可能跨会话并存两份 | 建议归属 | 理由 |
| --- | --- | --- | --- | --- |
| `kb`（三库） | 每个**项目**一份 | **是**（两个会话跑两个课题） | **preset + isolate realm** | 项目私有数据；放宿主会让第二个项目读到第一个项目的三库 |
| `projectState` | 每个**项目**一份 | **是** | **preset + isolate realm** | 同上；`project_state.json` 本就是项目级文件 |
| `ideaScore`（打分） | 无状态算法 + 读 `kb` | 否（无自有状态） | **preset**（跟随 `kb` 的 realm） | 它的状态就是 `kb`；必须与 `kb` 同 realm，否则读不到 |
| `expOrchestrator` | 编排状态按项目，但**资源**（GPU 实例、预算）是全局 | **部分** | **拆两层**：编排状态随 preset；**资源仲裁放宿主** | 若两份实例各自记账，预算上限（§20）会被绕过——两个项目各跑一个 72 小时的 GPU 任务 |

**结论（建议）**：`kb` / `projectState` / `ideaScore` 三个走 preset + `isolate` realm；
`expOrchestrator` **拆开**——项目内的实验编排状态随 preset，而"当前有几个 GPU 实例在跑、
已消耗多少预算"这类**跨项目的资源账本必须放宿主组合**，否则 §4.2 的 C 模式预算护栏形同虚设。

**一个必须避免的陷阱**：宿主平面的行**不能** `inject` 上述 preset 服务——注入在会话
存在之前就解析，没有 agent 可以按 key 查。若宿主需要读某个 agent 的 preset 服务，
dsh 提供的正解是 `agentPresets.serviceFor(agent, name)`（"A request that is ABOUT a
session but arrives from outside it, which is every browser RPC"）。它是只读寻址面，
不是注入面。

> ⚠️ **决策记录（2026-09-15）：用户已确认「就按建议执行」。**
> 本节的归属建议自此**冻结**为工程约束：
> - `kb` / `projectState` / `ideaScore` → preset + `isolate` realm；
> - `expOrchestrator` → 项目内编排状态随 preset，跨项目资源账本（GPU 实例、预算）放宿主组合；
> - 宿主读取 agent 的 preset 服务一律走 `agentPresets.serviceFor(agent, name)`，禁止宿主行 `inject` preset 服务。
>
> 后续修订需走文档变更记录，不得静默推翻。

### 4.5 【E6 增强】用作用域 prompt 章节承载"领域上下文 / 行为边界 / 输出契约"

v1.2 的 §16.2 五段式 prompt 骨架全部塞进 preset 的 persona。实际 `ctx.systemPrompt.section({ name, order, text })` 提供的是**作用域内有序章节**，且每次模型步前重新组装（L2）。因此：

| 骨架段 | 承载方式 | 理由 |
| --- | --- | --- |
| 1 角色定义 | preset `persona` | 会话期稳定 |
| 2 领域上下文 | **scoped section**，由 Domain Pack 注入 | 换 pack / 换绑版本时只换章节，不动 persona |
| 3 行为边界 | preset `persona` + `toolFilter` | 边界最终由工具面兜底，不靠文字 |
| 4 输出契约 | `outputSchema`（委派时）+ section 补充说明 | 机器约束优先于文字约定 |
| 5 完成判据 | **scoped section**，由状态机按 `current_stage` 动态生成 | 阶段变了章节就该变 |

**收益**：§16.2 的"术语词典超过 200 条时只注入相关子集"从一句愿望变成可实现的机制——章节文本是每次组装时计算的。

### 4.6 【E15】人工授权必须发生在委派之前

**问题**：v1.2 §7.2 的实验子 Agent 池（DataPrep / Train / Eval / Repro）与 §7.3 的
云 GPU 管理放在一起读，会得到一个隐含假设——子 Agent 在运行中需要授权时可以"问一下"。
**这个假设不成立。** 委派时子代理的审批策略被 dsh 硬性钉为 `'never'`
（`captureDelegatedPolicyOverrides`，见 §5.2），子代理**没有任何途径**发起审批请求。

**后果**：若把"启动云 GPU 实例"设计成子代理运行中途的动作，该动作会**静默失败或
直接不可用**，而不是弹出一个授权请求。夜间 C 模式跑长任务时这尤其危险——以为
在等人授权，实际是卡死或异常终止。

**修订设计：授权前置 + 结构化回退。**

```
① 委派前（主 Agent，有审批能力）
   主 Agent 判定本次委派是否需要受限动作
   → 需要：走 §4.3 三段式门控，用 ask_user_question 取得用户授权
   → 取得后写入 Authorization 记录，随委派参数下发

② 委派（主 Agent → 子 Agent）
   子 Agent 的 persona/briefing 中明确列出：本次已授权哪些动作、上限是多少
   （授权是数据，不是子代理的推断）

③ 子代理运行中
   - 在授权范围内：直接执行
   - 超出授权范围：**不得执行**，返回结构化 NeedsAuthorization
     { status: 'needs_authorization', action, reason, estimated_cost }

④ 主 Agent 收到 NeedsAuthorization
   → 视为一次阶段内 gate，走 §4.3 呈递给用户
   → 用户批准则补授权并重新委派（或向下发一条 send_message 更新授权）
   → 用户拒绝则记录并终止该实验分支
```

**落地形态**（已在 core 层实现，见 §7 附录 A）：

| 契约 | 位置 | 作用 |
| --- | --- | --- |
| `AuthorizedAction` | `core/src/scoring/idea.ts` | 四类受限动作：`launch_gpu_instance` / `call_billed_api` / `destructive_fs_operation` / `exceed_budget` |
| `Authorization` | 同上 | 授权范围 + 授权人 + 时间戳 + 预算上限 |
| `NeedsAuthorization` | 同上 | 子代理请求补授权的结构化载荷 |
| `isNeedsAuthorization()` | 同上 | 主 Agent 收到子代理结果后的判定入口 |

**为什么用「结构化回报」而不是让子代理报错**：报错会让主 Agent 无法区分
"实验失败了"与"缺授权"，前者该换方案、后者该问用户。把后者做成一个显式的、
有类型的返回值，主 Agent 才能据此走门控而不是误判为技术故障（对照 §19 降级矩阵：
"训练子 Agent 代码运行失败"与"缺授权"是两条不同的处置路径）。

**对 §4.2 模式表的影响**：C 模式的安全边界（计费 API / 破坏性文件操作 / 启动 GPU）
**全部在①完成**，不存在"运行到一半再降级询问"的路径。C 模式超限自动降级为 B
（§4.2）因此也必须表现为：主 Agent 在下一次委派前发现超限 → 不委派 → 转为呈递。
这与 §4.3 的三段式是同一套机制，不需要第二套。

---

## 5. Phase 0 Spike 修订与状态

### 5.1 S1 —— dsh 多 Preset 工具隔离 → **已 L1 实证（结论：改设计，且机制比预期更强）**

- **v1.2 的提法**：写 demo 验证两个 preset 各挂不同工具互不可见。
- **结论**：提法本身是错的问题。子代理不通过 preset 隔离（E1）。设计改为 §4.1。
- **实证（L1）**：脚本 `tests/spike-s1-tool-isolation.mjs` 驱动**真实**的
  `ToolRuntime` 与 `dsh-scope` 原语（从已安装的 dsh 0.1.5-rc.1 加载），
  12 条断言全部通过，无需重启宿主。证实：

  | 断言 | 内容 |
  | --- | --- |
  | S1-a | `allow` 白名单把工具从子 scope 的模型可见目录移除 |
  | S1-b | 限制只作用于子 scope，全局目录不受影响 |
  | S1-c | 被限制的工具在子 scope 中读作「不存在」（`undefined`），而非报错 |
  | S1-d | **scope 自身注册的工具豁免于自身限制** |
  | S1-e | 撤销限制的 disposer 生效，目录恢复 |
  | S1-g | 无 scope 的上下文调用 `restrict()` 被**显式拒绝** |
  | S1-h | 空过滤器 `restrict({})` 被拒绝 |
  | S1-j | 过滤器含未知工具名时**报错**，并列出已知工具 |
  | S1-k | `deny` 黑名单同样生效 |
  | S1-l | 祖孙 scope 链上的多条限制**求交集**，祖先自身层注册的工具沿链保持可见 |

**三条对 Phase 1 有直接影响的实现事实**（原文与勘误初稿都没有）：

1. **`restrict()` 有硬性 scope 守卫**。无 scope 时抛
   `tools.restrict() requires a scoped context (agent.ctx): a context-global
   restriction would mask every agent`。这意味着「一次误配置把所有 agent 的工具
   面砍掉」在运行时不可能发生——**§16.1 的隔离红线由 runtime 兜底，不只是靠我们写对**。
2. **未知工具名在施加限制时即失败**，并回报已知工具清单。因此
   `toolFilter` 里的拼写错误会立刻暴露，不会静默变成一个「什么都没过滤」的白名单。
   这一点对 Phase 1 的工具命名很重要：`toolFilter` 必须用**已注册的真实工具名**。
3. **豁免的是「不是我自己层的」，不是「全局层」**。运行时注释明确指出这个区别：
   早期实现把豁免集读作「全局层」，当 preset 把模型可见工具从宿主组合搬到 agent 平面后，
   它们变成了**祖先贡献**，于是子代理的过滤器「悄悄不再约束任何东西」。当前实现按
   「非自身层」判断，因此 **preset 贡献的工具同样受 `toolFilter` 约束**。
   → 这使 §4.1 的隔离设计成立：把 Orchestrator 的重上下文工具放在 preset 里，
   仍然能被委派时的 `toolFilter` 收紧。

4. **`createScope()` 产生的上下文不继承注入特权**。工具调用必须发生在一个声明了
   `inject: ['tools']` 的插件内部。这正是委派运行时的形态（它在子代理的创建窗口内
   注册结构化输出工具），Phase 1 若自建委派封装需遵循同样的形态。

### 5.2 S2 —— 子代理上下文隔离 → **机制已闭合（L2 源码级 + L1 原语级）**

- **结论（L2）**：`spawn` provider 不继承父会话历史（区别于 `fork`）；父 Agent 只拿到 `SubagentResult{ output, structured, diagnostic, stopReason }`。这正是 §1.3 原则四要的语义。
- **机制闭合（关键）**：`toolFilter` 与已验证的 `restrict()` 之间的链路已定位到确切源码。
  `@deepseek-ai/dsh-subagent` 的 `applyChildComposition()` 是委派的唯一装配点：

  ```js
  export function applyChildComposition(childCtx, parent, composition) {
      childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx);   // ① 继承父组合
      childCtx.systemPrompt.context({ name: 'subagent:delegation', ... });
      if (composition.persona !== undefined) {
          childCtx.systemPrompt.section({ name: 'deployment:persona-prefix', ... });
      }
      if (composition.toolFilter !== undefined)
          childCtx.tools.restrict(composition.toolFilter);               // ② 正是 S1 实证的原语
  }
  ```

  三点同时被这一处源码坐实：

  1. **① 行就是 E1 的根因**：子代理 `composeFrom(childCtx, parent.ctx)` 加入**父的**组合，
     所以"用另一个 preset 隔离子代理角色"在实现上不存在路径。勘误 §4.1 的结论由此从
     "文档注释这么说"升级为"唯一装配点这么写"。
  2. **② 行把 `toolFilter` 直接交给 `restrict()`**，而 `restrict()` 的语义已被 S1
     以 12 条断言 L1 实证。因此 S2 的剩余不确定性**不是**"隔离是否有效"，
     而只是"端到端委派是否如实传参"——后者的传参路径就是上文四行代码。
  3. `persona` 走 `systemPrompt.section()`，与 §4.5 的 scoped prompt 章节设计一致。

- **顺带发现的一条安全属性（v1.2 两份文档均未提及）**：
  `captureDelegatedPolicyOverrides()` 把子代理的审批策略**硬性钉为 `'never'`**，
  与父代理自身的策略无关：

  ```js
  approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  ```

  → **子代理不能发起审批请求**，它只能做父代理已被授权做的事。这对 §7 实验执行层是
  重要约束：Train/Eval 子代理无法在运行中请求"启动云 GPU 实例"的许可，此类需要人类
  授权的动作**必须由主 Agent 在委派之前完成**（或在父层排队），不能指望子代理中途问。
  这也解释了为什么 §4.2 的 C 模式安全边界必须放在主 Agent 的门控上而不是子代理上。

- **剩余验收项（端到端，待 `cv-agent-dsh` 委派工具落地）**：派发一个真实子代理，验证
  ① 子代理不携带父历史；② 父只收到 `structured`；③ `outputSchema` 违反时报错而非
  静默回传自由文本；④ 子代理确实看不到 `toolFilter` 排除的工具。

#### 5.2.1 上下文洁净的两个补充实证（L2 源码级）

**① `spawn` 确实不继承父历史，`fork` 才继承。** 两个 provider 的对比是结构性的：

| provider | `inheritsParentContext` | `start()` 传入的 seed |
| --- | --- | --- |
| `spawn-in-process` | `false` | `{}` —— **无 seed**，子代理从空历史开始 |
| `fork-in-process` | `true` | `completedTurnPrefix(parent)` 产出的父会话事件前缀 |

`spawn` 的 `prepareContinuable()` 同样返回 `{}`。因此 §1.3 原则四（重上下文操作
分发至子 Agent、主 Agent 保持洁净）在默认委派路径上**由 provider 语义保证**，
不依赖 prompt 自觉。这也说明：**不要用 `fork` 做实验类委派**——它会把父会话历史
一并带进子代理，正好与原则四相反。

**② 父代理拿到的结果确实是"压缩后的"，不是子代理的会话流水。**
`readResult()` 只做三件事：

```js
const own = child.session.snapshotEvents(boundary);   // 只看子代理自己的事件
const output = finalAssistantOutput(own) ?? [];       // 最终助手输出
return { output, structured: structured?.captured.value, stopReason };
```

它**不返回** `own`（子代理的完整事件流），只返回最终输出、结构化结果与停止原因。
这正是 v1.2 §9.4 上下文预算表里「只回传关键指标」的实现层对应物。

**③ 一条对 §19 降级矩阵有用的行为**：当声明了 `outputSchema` 而子代理**没有**
通过结构化输出工具应答时，`readResult` 不会编造 `structured` 字段，而是把
`stopReason` 从 `completed` 改判为 `error`（或 `aborted`）：

```js
if (stopReason === "completed") return { output, stopReason: cancelled ? "aborted" : "error" };
```

→ **结构化输出是可信的**：`structured` 字段存在，就说明子代理确实按契约应答过。
主 Agent 可以据此区分「正常结果」与「契约违反」，不需要额外校验。这条应作为
`cvagent_exp_*` 工具的返回处理依据。

### 5.3 S6 —— gate / 审批机制承载 ABC 模式

- **结论（L2 + L3 + 部分 L1）**：dsh **没有**可直接承载 §4 三模式的通用 gate 服务。可行路径是 §4.3 的三段式（状态落盘 + `ask_user_question` + 决议落盘）。
- **已 L1 的部分**：三段式里的状态机与门控判定已在 `packages/core/src/state/machine.ts` 实现，并由 `packages/core/tests/machine.test.ts` 覆盖（8 条）：判据未达标不产生 gate、达标产生待决 gate、`advance` 推进并写回滚点、`revise` 不推进、无 gate 时抛错而非静默推进、末阶段不越界推进、模式差异判定。
- **文件往返（L1）**：`packages/dsh-plugin/tests/state-store.test.ts`（10 条，真实磁盘）覆盖创建→落盘→读回→判定→决议→推进完整往返、快照回滚、跨会话恢复、半截 JSON 被拒、形状非法被拒、原子写不留 `.tmp`。
- **工具管线端到端（L1）**：`packages/dsh-plugin/tests/gate-tool.test.ts`（6 条）把门控工具经**真实 `ToolRuntime.execute()`** 跑通——参数校验、output schema 校验、失败结果的 `isError` 形状，全部走真实执行管线而非直接调函数。覆盖：
  - 未开始的项目如实回报 `{exists:false}`
  - 完整门控往返：读状态 → `cvagent_gate_resolve` → 落盘推进，并核对磁盘内容
  - **缺必填参数被参数校验拦下并返回 `isError`**（模型看到的是"哪个参数不合法"，不是堆栈）
  - 工具内部抛错时返回可读的 `isError`
  - 无待决 gate 时拒绝推进，且**状态未被改动**
- **剩余待验证**：`ask_user_question` 在真实会话中的呈递行为（需宿主重启 + 真实会话）。
- **已知限制（L2）**：`ask_user_question` 在 plan mode 生效期间被禁用；若部署没有可用的 answerer，审批类请求会 fail-closed。A 模式在无人在场的环境下会卡住——这恰好说明 **A 模式不该用于无人值守**，与 §4.1 表格一致。

#### 5.3.1 Cordis 插件装载的两个易错形态（E16，L1 实测）

写 `gate-tool.test.ts` 时连续踩了两次，都是"看起来对、运行才发现"的类型，
Phase 1 写 `cv-agent-dsh` 的插件行时会同样遇到，因此记录下来。

**① 动态 import 一个包得到的是 ESM 命名空间对象，不能直接当插件传。**
不同包导出的形态还不一样：

| 包 | 插件形态 | 正确传法 |
| --- | --- | --- |
| `@deepseek-ai/dsh-system-prompt` | `default` 是**插件类** | `ctx.plugin(module.default)` |
| `@deepseek-ai/dsh-tools` | 命名导出 `apply` + `static inject` | `ctx.plugin({ apply, inject })` 或直接 `new ToolRuntime(ctx)` |

若把前者的类拆成 `{ name, apply }` 普通对象，cordis 直接拒绝：
`invalid plugin, expect function or object with an "apply" method, received object`。
注意 `Object.keys(module)` 看起来"有 apply"是假象——那个 `apply` 是命名导出的，
不是 default 类的方法。

**② 嵌套插件必须 await，否则有激活竞态。**

```js
// ✗ 子插件未必已激活，外面读到的 runtime 是 undefined
await app.plugin({ name: 'host', apply(ctx) { ctx.plugin(child) } })

// ✓ 在父插件的 apply 内 await 每个子插件
await app.plugin({ name: 'host', async apply(ctx) { await ctx.plugin(child) } })
```

**对 Phase 1 的意义**：`cv-agent-dsh` 的插件入口应当导出一个标准的
`{ name, inject, apply }` 或插件类，并在 `apply` 内 **await** 它自己的子插件
（Service、工具行、prompt 章节）。同时，任何"注册后立刻使用"的代码路径都要
意识到注册是异步落地的。

#### 5.3.2 E17 / E18：Phase 1 落地状态族时踩到的三个运行时坑（L1）

写 `cv-agent-dsh/state` 服务与 `state-tools` 工具行时，真实运行时连续三次拒绝，
逐一定位如下（都已修复并有测试覆盖）：

1. **解构丢失 this（E17）**：`const { register } = ctx.tools` 后调用 `register(...)`
   会在 ToolRuntime 内部以 `this.layers` 未定义失败。`register` 依赖实例字段，
   必须以 `ctx.tools.register(...)` 方法调用形态使用。教训：dsh 服务的方法**不要
   解构**。

2. **schemastery 默认值不是构造器语义（E18-①）**：`Config` 的 `.default()` 只在
   Loader 按 schema 校验行配置时注入。测试/宿主代码直接 `new Service(ctx, config)`
   时字段是 `undefined`——`project_id` 因此被 `JSON.stringify` 静默丢弃，落盘状态
   被形状校验拦下。构造器必须显式 `config.x ?? 默认值`。

3. **loader 的行模块导出形态（E18-②）**：行名 `cv-agent-dsh/state` 解析到的模块
   必须有 `default`（插件类）或命名 `apply`；只有命名导出会被拒
   （`invalid plugin ... received object`）。服务行加了 `export default` 后，
   隔离 profile 实机装载通过（§5.4 同款验证）。

4. **不带 config 的行拿到 undefined（E19）**：`cv-research` preset 里的
   `cvagent-state` 行没写 config（默认值本应生效），mount-validate 报
   `Cannot read properties of undefined (reading 'projectDir')`。schemastery 的
   `.default()` 只在 Loader 校验**非空**行配置时注入。修复：构造器
   `config = {}` + `resolveStateConfig(config)` 纯函数显式落定默认值
   （11/11 测试含回归用例）。

5. **主 Agent 工具面限制的机制缺口（E20，已闭环为执行级护栏）**：
   - **调查结论（L2）**：主 Agent 的 setup 窗口由
     `dsh-api-session-controller.composeAgent()` 硬编码——`setup: async
     (agentCtx, agent) => { installSelection(agent); await presets.mount(agentCtx,
     resolvedId) }`，没有第三方扩展点；`restrict()` 又要求 agent 自身 scope。
     因此**目录级**隐藏主 Agent 的重上下文工具在当前 dsh 版本不可行。
   - **落地方案（L1）**：`cv-agent-dsh/orchestrator-guard` 行监听
     `tools/pre-execute` waterfall，用 `agents.roots()` 区分根/子代理，对
     **根 agent** 拒绝 `read_*` / `download_*`（默认 10 个名字，可配置）。
     6 条集成测试经真实执行管线验证：根 agent 被拒（isError + 可读理由）、
     未禁工具放行、**子代理不受护栏影响**（归 toolFilter 管）、无 agent 调用
     fail-open、自定义名单覆盖默认。
   - **语义边界**：护栏让主 Agent 拿不到结果，但工具名仍在目录里；目录级
     隐藏需 dsh 提供 setup 扩展点，留待后续版本。护栏行不提供服务，故放在
     isolate group 之外（与 standard 的 tool 行同规则）。

6. **E22（L1）：`!!js` 求值出 `undefined` 会让整行校验失败，拖垮整个 preset 挂载
   ——而报错信息会把人引向错误的方向。**

   `cv-research` preset 的 `mcp-asta` 行**首次真机挂载即失败**，切到该 preset 直接报
   「无法切换到『CV Research Orchestrator』」。报错原文（节选）：

   ```
   failed to apply loader entry mcp-asta (@deepseek-ai/dsh-mcp-client): invalid config:
     - expected { transport: "streamable-http", ..., headers: { [key: string]: string }, ... }
     but got {"serverName":"asta","transport":"streamable-http","url":"...","headers":{}}
   ```

   **误导点**：错误里显示 `headers: {}`——但用**真实 Config schema** 逐形态实测：

   | headers 形态 | 结果 |
   | --- | --- |
   | `{}` | **通过** |
   | `{ 'x-api-key': '' }` | **通过** |
   | `{ 'x-api-key': undefined }` | **拒绝** |

   `{}` 是完全合法的形状。报错显示成 `{}`，是因为 loader 用 `JSON.stringify` 渲染
   违规值，而它**会丢掉值为 `undefined` 的键**。按字面去找「空 headers 的 bug」
   会白费时间。

   **根因**：宿主进程没有 `ASTA_API_KEY`，`!!js process.env.ASTA_API_KEY` 求值为
   `undefined`，headers 成了 `{ 'x-api-key': undefined }` → 校验失败。

   **对 E19 的修正**：E19 记的是「一个坏行会让 mount 失败」；此处证明**配置校验失败
   同样如此**，而且 `failOnStartupError: false` **兜不住它**——那个开关只覆盖**连接**
   失败。「降级为没有检索工具」的前提是**配置先合法**。

   **修复**：`x-api-key: !!js process.env.ASTA_API_KEY || 'UNSET'`，保证值永远是字符串。
   缺 key 时配置合法、连接失败，才轮到 `failOnStartupError: false` 把它降级成
   「没有检索工具 + 日志报错」。

   **工程配套**：`scripts/start-dsh-web.ps1` 启动前做四项检查（代理变量、key 是否存在、
   代理端口是否在监听、**真实连通性预检**）；`scripts/check-asta.mjs` 走一次
   initialize + tools/list，把「key 存在」升级为「key 真的能用」。

### 5.4 bundle 装载的 L1 实证（替代了「必须重启宿主」）
初稿把「新增 bundle 行在真实会话中生效」列为必须重启宿主才能验证的项目。**该结论已作废**：
用一个**隔离的 `DSH_HOME`**（不改动运行中的宿主、不占用默认端口）即可完整验证装载链路。

复现步骤（全部在仓库工作区内，不需要提权）：

```powershell
$env:DSH_HOME = "D:\Code\VScodeRepo\dsh-plugin\.spike-dsh-home"
dsh --profile cvspike --from-default-profile web --dump-config        # 从内置模板建隔离 profile
dsh plugin --profile cvspike add "link:D:\...\packages\vendor\dsh-ai4scholar"
dsh --profile cvspike --port 0 --no-open                              # 启动，OS 分配端口
```

实测结果：

| 检查 | 结果 |
| --- | --- |
| 组合后的配置树包含该 bundle 行 | ✅ `# == dsh-ai4scholar` 层贡献 `- id: ai4scholar`（组合树共 153 行） |
| 进程能否启动并完成装载 | ✅ `dsh web: http://127.0.0.1:51403/?token=...`，无模块解析或激活错误 |
| 插件是否真的执行了 `apply` | ✅ `GET /ai4scholar/balance` 返回 **200** `{"ok":false,"code":"MISSING_KEY","error":"AI4Scholar API key is not configured"}` |

最后一条是决定性证据：该路由由插件的 `applyCreditsTools()` 注册，**只有 `apply` 真的跑过它才存在**。
`MISSING_KEY` 是预期结果（隔离 profile 没有配置密钥），恰好证明插件按设计通过
`ctx.credentials` 惰性解析密钥，而不是在装载时因缺密钥而失败。

> 因此：**你不再需要为验证插件装载而重启 GUI 宿主。** 仍需重启的只有一件事——
> 让 `web` profile（也就是你正在用的这个 GUI）本身加载新 bundle。若你想在 GUI 里直接用
> 那 38 个工具，仍要重启一次；但装载正确性已经证明，重启不再是「未知风险」。

### 5.5 仍未验证（需外部资源）

| # | 项目 | 为什么现在做不了 | 建议时机 |
| --- | --- | --- | --- |
| 1 | S2 端到端：真实子代理的 `toolFilter` / `outputSchema` 行为 | 需要 web profile 加载 `cv-agent-dsh` 的委派工具；当前宿主进程正承载本次对话 | bundle 装载已验证（§5.4），待 `cv-agent-dsh` 首批工具落地后由我实跑 |
| 2 | S6 端到端：`ask_user_question` 的门控呈递行为 | 同上 | 同上 |
| 3 | S3 MinerU 本地吞吐 | 需要 4090 机器 + MinerU 部署 | 与 dsh 侧并行，不阻塞 |
| 4 | S4 sqlite-vec 压测 | 需要选定 embedding 维度 | ✅ **已解决（2026-09-17，`scripts/spike-s4-retrieval.mjs`）**：结论是我们这个规模**不需要向量索引**（1000 条 × 768 维暴力全扫 **1.19ms/次**，Phase 3 的几百条更不在话下）；FTS5 可用，中文检索走 `tokenize='trigram'` 且**查询串须 ≥3 字符**（2 字中文查不到，实测边界）；`node:sqlite` 加载扩展需 `new DatabaseSync(path, { allowExtension: true })`（sqlite-vec 技术上可加载）。**剩下的是 embedding 来源决策，不是索引决策**（见 §9） |
| 5 | S5 MCP 封装 | 依赖 core 层有可封装的接口 | Phase 1 后 |
| 6 | ai4scholar.net 真实调用与计费标定 | 需要 API key 与额度 | Phase 2 前（影响 §20 成本模型） |

> ⚠️ 关于 GUI 宿主：bundle 的**装载链路**已用隔离 `DSH_HOME` 实证（§5.4），
> 我不需要、也没有重启你正在使用的 GUI 进程。若你想在当前 GUI 会话中直接调用
> dsh-ai4scholar 的 38 个工具，仍需重启一次宿主；但那是「让 GUI 用上」，不是「验证能不能用」。

---

## 6. 对 §12 路线图的修订建议

v1.2 的 Phase 划分基本合理，但有三处需要调整：

1. **Phase 0 的 S1/S2/S6 描述改写**（§5），并明确"S1 的结论是改设计而非改实现"。
2. **Phase 1 增加一项独立任务：服务平面归属判定**（§4.4 末尾）。这是"改起来代价很大"的决定，必须在写任何 Service 之前完成，不宜并入"注册骨架"。
3. **Phase 2 增加前置：ai4scholar 真实调用与计费标定**（§20 成本模型的输入）。否则 C 模式预算护栏（§4.2）没有可用参数。
   → 2026-09-15 用户裁定：**检索暂时走 asta 通道**，此前置相应降级为"asta 通道的成本/限额摸清"。

---

## 7. 下一步（按依赖排序）

| 顺序 | 事项 | 依赖 | 状态 | 谁能做 |
| --- | --- | --- | --- | --- |
| 1 | 评审并冻结本文件的 §4.1 / §4.2 / §4.4 / §4.6 | — | ✅ 已裁定（2026-09-15，用户确认按建议执行；见 §4.4.1 决策记录） | 你 |
| 2 | 服务平面归属判定：`kb` / `ideaScore` / `expOrchestrator` / `projectState` 各自归宿主还是 preset | §4.4 | ✅ 已裁定（同顺序 1） | 你 + 我 |
| 3 | S1 工具白名单隔离实证 | — | ✅ 已完成（L1，12 条断言） | 我 |
| 4 | S2 委派机制闭合：`toolFilter` → `restrict()` 链路定位 | — | ✅ 已完成（源码级 + S1 原语实证） | 我 |
| 5 | S6 状态机与门控判定实现 | — | ✅ 已完成（`core/state/machine.ts`，8 条测试） | 我 |
| 6 | bundle 装载链路实证 | — | ✅ 已完成（隔离 `DSH_HOME`，§5.4） | 我 |
| 7 | E15 授权模型落地：`Authorization` / `NeedsAuthorization` 契约与判定 | — | ✅ 已完成（§4.6，9 条测试） | 我 |
| 8 | §16.1 角色矩阵的可执行规格（逐角色断言工具面） | — | ✅ 已完成（5 个角色，真实 runtime 断言） | 我 |
| 8b | S6 门控完整往返：`project_state.json` 持久化 + 快照回滚 | — | ✅ 已完成（10 条测试，真实磁盘） | 我 |
| 8c | S2 上下文洁净：`spawn` vs `fork` 与结果压缩机制 | — | ✅ 已完成（源码级，§5.2.1） | 我 |
| 8d | S6 工具管线端到端：门控工具经真实 `ToolRuntime.execute()` | — | ✅ 已完成（6 条测试，§5.3、§5.3.1） | 我 |
| 9 | 冻结三库 schema（v1.2 §14 的待决策项，也是 Phase 2 的截止点） | — | **待你**（Phase 2 开工前） | 你 |
| 10 | 写 `cv-agent-dsh` 的第一批 row + `cvagent.*` 工具并链入 profile | 1、2 | ✅ 状态族完成：`projectState` 服务 + 5 个工具（`cvagent_state_get/advance/rollback`、`cvagent_mode_set`、`cvagent_gate_resolve`），10 条测试 + 隔离 profile 实机装载验证通过；cv-research preset 待续 | 我 |
| 11 | S2 / S6 端到端实跑（真实子代理的 `toolFilter`、`outputSchema`、`ask_user_question` 呈递） | 10 | 待 cv-research preset | 我 |

> 顺序 1、2 已由用户裁定（2026-09-15：「就按照你建议的来做」）。
>
> ## Phase 1 进度（2026-09-15 起）
>
> | 交付物 | 状态 |
> | --- | --- |
> | `projectState` 服务（`cv-agent-dsh/state`） | ✅ 完成：文件持久化 + 门控语义封装 + 动态 prompt 章节（§4.5 落点） |
> | 状态族 5 工具（`cv-agent-dsh/state-tools`） | ✅ 完成：真实 ToolRuntime 管线，11 条测试（含三模式空流水线验收与 E19 回归） |
> | 主编排护栏（`cv-agent-dsh/orchestrator-guard`，E20） | ✅ 完成：执行级拒绝根 agent 的 read_*/download_*，6 条集成测试；已接入 preset |
> | 隔离 profile 实机装载验证 | ✅ 通过：`cv-agent-dsh` 链入 profile，两行经 overlay 装载，进程启动无激活错误（E18-② 修复后） |
> | cv-research agent preset（standard 裁剪 + isolate group） | ✅ 已产出：`~/.dsh/.agent-presets/cv-research/`（persona + `isolate: { projectState: true }` group + 状态族两行 + E20 护栏行）。**mount-validate 终验通过**（2026-09-15 宿主重启后，`standingKeyFor('cv-research')` 无错误挂载成功——E21 的双缓存随之清零） |
> | 空流水线演示（真实会话里三模式走通） | ✅ 工具层已验收（11 条测试含三模式全走通 + 回滚）；真实会话体验：新开会话选择 CV Research Orchestrator 即可 |

---

## 7.5 Phase 2 启动（2026-09-15 决策记录与检查单）

### 7.5.1 决策记录（用户确认）

| # | 决策 | 对 v1.2 的变更 | 影响 |
| --- | --- | --- | --- |
| D1 | 学术检索**暂时走 asta 通道** | 推翻 §2.2「asta-skill 未检索到 → 忽略」 | Scout 的主检索通道改为 asta；dsh-ai4scholar 检索族降级为**备选/元数据补全**（其 38 个工具仍在库，`search_semantic_paper_match` 仍用于本地百篇论文的标题匹配补全）。§5.1 的 Scout `toolFilter` 白名单需按 asta 的**实际形态**重做 |
| D2 | MinerU 改为 **API 形式**（Key 已配置） | 推翻 §2.3「本地部署优先」 | 落盘流水线的 `parse_channel: mineru` 直接实现为 REST 适配器（`POST /tasks` 异步任务 + 轮询，v1.2 §2.1 已核实该接口存在）；省掉本地部署与 GPU 占用。需确认：API 端点、key 的环境变量名、并发与限流参数（§19 降级矩阵的"解析失败/超时 → 快速通道"仍然适用） |
| D3 | 学术检索与 MinerU 的 **API key 均已配置** | — | 走 dsh credentials wire API 或 `.env`（§23 密钥卫生：key 字面值不进 prompt、不进 git） |

### 7.5.2 三库 schema 冻结提案（Phase 2 的启动截止项，待你批准）

按 v1.2 §5.4 与 §17.1 的 DDL 整理，冻结范围**只含基础字段**（扩展字段走
Domain Pack 的 `ext` JSON 列，不冻结）：

| 表 | 冻结字段 |
| --- | --- |
| `papers` | `paper_id`(PK)、`title`、`authors`(JSON)、`year`、`venue`、`citation_count`、`doi`、`arxiv_id`、`pmid`、`url`、`oa_pdf_url`、`abstract`、`pdf_status`(pending/downloaded/missing)、`parse_channel`(mineru/quick_read/NULL)、`extraction_quality`(full_text/abstract_only/NULL)、`md_path`、`created_at`、`updated_at` |
| `problems` / `methods` / `innovations` | `entry_id`(PK)、`statement`、`ext`(JSON)、`source_papers`(JSON)、`created_at`、`updated_at`；向量外置 vec0 虚拟表 |

相对 v1.2 的两处**明确变更**（已在 core 契约里先行实现，请一并批准）：

1. **三库条目统一用 `statement` 字段名**（v1.2 §5.4 表格里的
   `problem_statement` / `method_name` / `innovation_statement` 作为语义别名，
   不再进表结构）——`packages/core/src/schema/kb.ts` 已如此实现。
2. **检索结果必须携带 `retrieval_mode`（vector / keyword_only）降级标记**
   （§19 降级矩阵要求，但 v1.2 §10 的 `ScoringReport` 无承载字段，
   勘误已补；`kb.search` 契约同样携带）。

**本提案补充的三处实现细节**（asta 裁定与工程教训的落点，一并批准）：

3. `papers` 增加 **`source_channel`** 字段（`asta` / `ai4scholar` / `manual`，
   默认 `manual`）——检索层不写死通道，入库统一走规范化记录，通道差异留在
   这一列 + 通道适配器里。
4. **去重键优先级**：`paper_id` 精确匹配（DOI/arXiv ID 归一化：小写、去
   `arXiv:`/`https://doi.org/` 前缀）→ `doi`/`arxiv_id`/`pmid` 任一命中合并
   （保留较长 abstract、union authors）→ 标题归一化匹配仅作人工复核级线索，
   不自动合并。
5. **结构迁移纪律**：`metadata.db` 附带 `schema_migrations` 表；本提案冻结后的
   任何结构改动走版本化迁移脚本，禁止原地漂移（E 系列教训的延续）。索引：
   `papers(doi)`、`(arxiv_id)`、`(pmid)`、`(title)`、`(year)`。

### 7.5.3 启动检查单（阻塞项排最前）

| # | 事项 | 状态 | 谁能做 |
| --- | --- | --- | --- |
| P2-0 | **三库 schema 冻结提案批准**（§7.5.2） | ✅ 已批准（2026-09-16，用户「全批，按 §7.5.2 冻结」） | 你 |
| P2-1 | 确认 asta 通道的**形态**（dsh skill？MCP 工具？CLI？）与其检索结果的输出结构 | ✅ 已解决：Asta MCP（Ai2，`asta-tools.allen.ai/mcp/v1`，streamable-http + `x-api-key`），8 个工具 `mcp__asta__*`，名字契约在 `names.ts`；`tests/spike-asta-mcp.mjs` L1 实证 + 连通预检 v1.12.3 通过；preset 已有 `mcp-asta` 行 | 我 |
| P2-2 | 本地百篇 PDF 的目录路径 | ✅ 已解决：`C:\Users\Admin\Zotero\storage`（递归），实测 **151 篇 PDF** | 我 |
| P2-3 | MinerU API 端点 + key 环境变量名 + 限流参数 | ✅ 已完成：`docs/mineru-api.md`（端点全部实测、`MINERU_TOKEN` 在 `.env.local` 已验、官方限流与上传优先链路）——P2-4 直接按它实现 | 我 |
| P2-4 | 论文库落盘流水线：`metadata.db` 初始化、`cvagent_kb_import_paper`、MinerU API 适配器（异步任务 + 轮询） | ✅ 实现 + 接线 + **重启后验证通过**：kb 组经 `standingKeyFor('cv-research')` 挂载成功；mineru-quota 行在宿主组合树中就位 | 我 |
| P2-5 | Scout 检索（asta 主通道 + dsh-ai4scholar 备选）与去重合并 | ✅ 本地导入 + Asta 富化完成：147 条入库，**145/147 有外部 ID**（DOI 134 / arXiv 61）；2 条无结果留待人工。`scripts/import-zotero.mjs`（幂等）+ `scripts/enrich-asta.mjs`（标题归一化相等才合并、1s 节流）。**L1 新坑**：asta `search_paper_by_title` 的 `fields` 带 `abstract` 会让服务端挂起（MCP -32001 超时），只用 `title,year,venue,externalIds`；返回形状为 `value.content[0].text` 内嵌 JSON | 我 |
| P2-6 | Reader 结构化提取（走 outputSchema 的子代理）与 Analyst 三库更新 | ✅ Reader 侧完成：`cvagent_kb_extract` 工具化（`kb/extract-tool.ts`）——spawn Reader 子代理（toolFilter `{read}`、`READER_PERSONA`、outputSchema=PaperExtraction 编译、maxDepth 0），结构化结果 `coerceExtraction` 校验后 `kb.saveExtraction` 落库；`kb` 服务开放 `saveExtraction/getExtraction/extractionCount`；preset kb 组加 `cv-agent-dsh/kb-extract` 行并同步工作副本；kb-extract 测试 6 个全绿（dsh-plugin 65）。**Analyst 三库条目生成在 P2-7 以委派角色落地**（21 篇提取 → 104 条条目，见 §8.4；仍是「角色 + 脚本装载」，未冻结为工具） | 我 |
| P2-7 | Phase 2 验收：从 0 检索某 Deepfake 子主题 → ≥100 篇论文库与三库，抽检 20 篇 | ✅ **通过（2026-09-17，记录见 §8）**：① 批量 MinerU 解析 **146/146 成功、0 失败**（额度 1900/2000 页，断点续跑不重复计费）；② Asta 从零检索「音频深伪」子主题：发现 244、**入库 243**（外部 ID 244/244），论文库 147 → **390**；③ 抽检 **20 篇**（分层 arxiv/doi/local）+ 20 个真实 Reader 子代理，21 篇提取契约 **100% 通过**，3 篇逐条回原文核验字面命中；④ 三库 **104 条**（P14/M21/I69）。通道形态与工程教训改写为 E22–E25 | 我 |

> P2-0 是 Phase 2 的**启动闸门**（v1.2 §14 的截止项）。P2-1/2/3 是外部事实，
> 不阻塞 schema 冻结，但阻塞 P2-4/5 的实现。

---

## 8. Phase 2 验收记录（P2-7，2026-09-17）

P2-7 的验收口径（§7.5.3）：**从 0 检索一个 Deepfake 子主题 → 论文库与三库成形，抽检 20 篇**。
本轮三件事一次做完，全部走**真实通道**（真 API、真子代理、真落盘），没有 mock 或手工补数据。

### 8.1 批量 MinerU 解析：146/146 成功，0 失败

| 指标 | 结果 |
| --- | --- |
| 合格论文（未解析 + 有本地 PDF） | 146 篇（另 1 篇试点已解析 → 语料合计 **147 篇全解析**） |
| 提交 | 8 个 chunk × 20 文件（MinerU 批量上限 50，取 20 保守） |
| 解析成功 | **146 / 146**（失败 0；`full.md` 缺失 0） |
| 额度消耗 | **1900 / 2000 页**（跨天重置；1621 页越过 80% 告警线——账本只告警不拒绝，符合 §4 语义） |
| 落盘 | `data/papers/markdown/`，DB `md_path` 完整性核查 **147/147** 存在且 ≥1KB |
| 断点续跑 | 两次中断（429 限流、路径崩溃）后 `--resume` 只轮询+落库，**未重复提交、未重复计费** |

新增脚本 `scripts/batch-parse.mjs`：分块提交 → MinerU 并发处理 → 逐块轮询 → 解压落盘 → 写
`md_path` → 额度记账；带 `--resume`（状态文件 `data/papers/batch-state.json`）、`--dry-run`
（预算与名单预演）、幂等跳过（已解析的不重复下载与计费）。三条 L1 教训见 **E23/E24/E25**。

### 8.2 Asta 从零检索控制组：发现 244 篇 / 入库 243 篇

子主题选**音频深伪检测**（audio deepfake detection）——原语料 147 条里只有 3 条 audio-visual，
是真正的「从 0」，能暴露检索通道本身的系统性问题。

| 指标 | 结果 |
| --- | --- |
| 关键词组 | 4 组（audio deepfake detection / deepfake voice detection / spoofed speech detection / audio anti-spoofing countermeasure） |
| 发现 | 244 篇**互不重复**论文（`snippet_search` limit=100 ×4 组） |
| 元数据富化 | 244 / 244（`get_paper_batch` 按 CorpusId 批量补 DOI/arXiv/year/venue） |
| 外部 ID 覆盖 | **244 / 244**（234 DOI、142 arXiv） |
| 入库 | **新入库 243**、标题命中待复核 1（§7.5.2 纪律：标题命中不自动合并）、失败 0 |
| 论文库总量 | 147 → **390**（`source_channel`：manual 147 / asta 243） |
| 通道内重复 | 归一化标题重复组 **0**（去重生效） |

**通道形态被实测改写**（E22）：`search_papers_by_relevance` 的 `limit` **不生效**，只回单篇——
批量检索必须走 `snippet_search`；且 MCP 结果的 `content[0].text` 只渲染第一条，完整数组在
`value.structuredContent.result`。脚本：`scripts/asta-control.mjs`（证据脚本
`scripts/probe-asta-search.mjs`、`scripts/probe-asta-shape2.mjs`），汇总落
`data/papers/asta-control-summary.json`。

### 8.3 抽检 20 篇 Reader 提取：21 篇入库、0 契约违规

| 指标 | 结果 |
| --- | --- |
| 抽样 | 20 篇（分层 arxiv 7 / doi 7 / local 6；排除已有提取；≥20KB；`scripts/pick-spotcheck.mjs`） |
| 执行 | 20 个**真实 Reader 子代理**（spawn，独立上下文，只读文件 + 写 JSON） |
| 契约校验 | 21 个提取文件（20 抽检 + 1 试点）**全部通过**，非法 0、警告 0（`scripts/load-extractions.mjs`） |
| 入库 | `paper_extractions` 21 篇，`papers.extraction_quality` 镜像 21 条 |
| 人工核验 | 3 篇逐条回原文核对（WMamba / 音视频同步 / DeepFake-Adapter）：τ=15、Gaussian target、16.92M→19.28M、4×V100、PD@10% 语义等**全部字面命中**，无编造 |
| 拒绝编造的行为 | 多处「原文无 Limitations/Future Work 章节」被如实留空数组（而非用常识补写） |

### 8.4 三库条目（Analyst 归纳）

Analyst 子代理从 21 篇提取归纳出 **104 条**三库条目（含试点已有 6 条）：

| 库 | 条目数 | 说明 |
| --- | --- | --- |
| problems | **14** | 跨论文概念（跨数据集/跨伪造手法泛化、持续学习遗忘、公平性与偏置、可解释性、音视频一致性、对抗鲁棒性、主动防御、实时与轻量化部署、无标注/真实数据条件、局部篡改细微伪影、AI 生成内容、通用主干表征…） |
| methods | **21** | 每篇论文一条（试点 M001 + 本批 20），含范式/主干/训练策略/泛化目标四栏 |
| innovations | **69** | 机制级创新（模块/损失/数据集/评测协议），每篇 2–4 条 |

- **ID 与关联**：ID 由入库时分配（P002–P014、M002–M021、I005–I069）；`related_problem_ids` /
  `related_method_ids` 在各库 ID 落定后由 `scripts/link-entry-ids.mjs` **按 source_papers 交集
  机械回填 90 条**（Analyst 生成时 ID 尚不存在，故留空）。
- **一处人工合并**：Analyst 的「实时与轻量化部署」与原 P001 语义重合但归一化不同（不会被静默丢弃）。
  裁决：把 P001 的 statement 改为 Analyst 的精确表述（原表述把「跨数据集泛化」也卷了进来，而本批
  已把跨数据集泛化单列为独立 problem），随后装载时**合并**——P001 的 `source_papers` 取并集（8 篇）。
- **契约校验**：`scripts/load-entries.mjs` 硬错误 0、警告 0（枚举/溯源/归一化重复三项全过）；
  65 条 innovations 的 statement 归一化后两两不同，无静默丢条目。

### 8.5 验收结论

- **论文库**：390 篇（≥100 ✔），其中 243 篇由 Asta 从零检索通道产生，外部 ID 全覆盖；
- **解析深度**：147 篇全文解析（≥20 ✔），md_path 完整性 100%；
- **抽检**：20 篇（✔），提取契约 100% 通过，人工核验 3 篇逐条命中；
- **三库**：104 条（problems 14 / methods 21 / innovations 69，≥100 ✔），条目全部可溯源到论文
  （`source_papers`），90 条已回填 `related_*_ids` 关联；
- **遗留**（不阻塞 Phase 3）：243 篇 Asta 论文只有元数据（`pdf_status='pending'`），
  全文获取需接 `paper-fetch`/Zotero 通道后二次批量解析；1 条标题命中待人工复核。

### 8.6 待执行：重启后的真实端到端验收（§5.5 第 1、2 项的收口）

Phase 2 的提取链路是用**假 subagents 提供者**做契约测试的（6 条），真实委派行为还没在
`cv-research` preset 里跑过。原因是 E21：新 exports（`./kb-extract`）与模块代码都被运行中的
宿主缓存，**必须重启一次宿主**才能让该行生效。

重启后按此清单收口（一轮即可，预计 10 分钟）：

| # | 步骤 | 通过判据 |
| --- | --- | --- |
| 1 | 新会话选 **CV Research Orchestrator**，看工具目录 | 含 **21 个 `cvagent_*`**（状态与门控 6 + 知识库 8 + idea 2 + **领域包 4** + **写作 1**）与 **8 个 `mcp__asta__*`**。⚠️ 别拿 `names.ts` 的 25 个声明名当预期：其中 4 个是「有名字、无行注册」（exp 四个，已撤销）。这条已可执行：`node scripts/check-tool-catalog.mjs [--with-asta]` |
| 2 | 对一篇**已解析**论文调用 `cvagent_kb_extract` | 返回结构化三字段；`paper_extractions` 新增/更新该 paper_id |
| 3 | 验证上下文洁净 | 主 Agent 上下文里**没有论文正文**（只有结构化结果）；子代理会话历史不含父会话 |
| 4 | 验证契约刚性 | 把 `outputSchema` 必需字段之一去掉重跑，子代理应报错而非回自由文本 |
| 5 | 验证隔离红线 | 子代理目录里看不到 `mcp__asta__snippet_search`、`read_*`（只有 `read`） |
| 6 | 门控呈递（S6） | `cvagent_state_advance` 产出待决 gate → 由 `ask_user_question` 呈递 → `cvagent_gate_resolve` 落盘；confirm 模式下不决议就不推进 |

---

## 9. Phase 3 起步（2026-09-17）

### 9.1 全文获取：paper-fetch skill + 回填桥

Phase 2 留下的最大缺口是「243 篇 Asta 论文只有元数据」。已按用户决定落地为**三层分工**：

| 层 | 归属 | 职责 |
| --- | --- | --- |
| 解析+下载 | `packages/dsh-plugin/skills/paper-fetch/`（**插件自有 skill**，v0.14.1，Python 3 stdlib，随包 `files: ["skills"]` 分发） | Unpaywall → Semantic Scholar → arXiv → Europe PMC/PMC → bioRxiv/medRxiv；Sci-Hub 按本仓库策略**默认关闭**；`%PDF` 魔数 + 50MB 上限校验；batch 模式 + 幂等文件名 |
| 回填桥 | `scripts/fetch-fulltext.mjs`（`--prepare` / `--ingest` / `--status`） | 从 `metadata.db` 生成 DOI 清单 → 读 paper-fetch 的 JSON envelope → 映射回 `paper_id` → 写 `pdf_path`/`pdf_status`（落库前**再校验一次魔数**） |
| 解析 | `scripts/batch-parse.mjs` + MinerU | 与 Phase 2 完全同一套（额度台账、断点续跑、`--resume-batch` 定向补收） |

- skill 根由 `skill-filesystem` 的 `customSkillDirs` 钉死（`CV_PROJECT_SKILLS_DIR` / `CV_PLUGIN_SKILLS_DIR`），与「会话工作区」解耦——否则换工作区跑项目会**静默没有 skill**。
- 子进程 I/O 一律**重定向到文件**而非管道：本 harness 沙箱禁止用管道捕获子进程输出（Node `child_process` 默认 `stdio:'pipe'` 会 EPERM）。
- ⚠️ `UNPAYWALL_EMAIL` 未配置 → Unpaywall（首选 OA 源）被跳过，只剩 S2/arXiv/PMC/bioRxiv 四条。

### 9.2 本轮实测结果

| 指标 | 结果 |
| --- | --- |
| 候选 | 243 篇（全部有 DOI 或 arXiv；170 篇只有 DOI） |
| 已下载 | **73 篇**（130MB，全部通过魔数校验） |
| 中断原因 | **代理 `127.0.0.1:10808` 掉线**（端口不可达，curl 000）——arXiv/Unpaywall/S2/出版商全部需要代理，故中止；脚本幂等，代理恢复后重跑即续传 |
| 阻断期间完成的另一件事 | 代理掉线**不影响 MinerU**（国内直连），因此顺手把已下载的切片跑了一遍解析验证 |
| 解析验证 | 7 篇（限额预算内的切片）**全部成功**，`md_path` 100% 可解析 → 证明 **paper-fetch 下载的出版商 PDF 与 arXiv PDF 都能喂给 MinerU** |
| 解析总量 | 147 → **154 篇**；额度 1990/2000 页（今日配额基本用尽） |
| 待抓/待解析 | 170 篇待抓（需代理）；66 篇已抓待解析（需额度） |

### 9.3 S4 检索层结论（对应 §5.5 第 4 项）

`scripts/spike-s4-retrieval.mjs` 的结论把「向量索引」这个不确定性**去掉了**：

- **我们不需要向量索引**：1000 条 × 768 维暴力全扫 **1.19ms/次**（384 维 0.75ms）。Phase 3 的三库规模（当前 104 条）远在此之下，暴力扫描足够；
- **FTS5 可用**，中文检索走 `tokenize='trigram'`（实测 3 字/4 字查询命中，**2 字查询查不到**——trigram 的硬限制）；
- `node:sqlite` 加载扩展需显式 `{ allowExtension: true }`（sqlite-vec 技术上可加载，但不是必需）。

→ **剩下的决策是「embedding 从哪来」，不是「用什么索引」**。当前部署只有 `deepseek-official` 对话模型，无 embedding 服务，故三选一：① 本地 ONNX 小模型（如 bge-small-zh，零 API 成本，需一次性下载）；② 外部 embedding API（需 key，代理已具备）；③ 暂不上向量，先用 FTS5 trigram + 三库结构化字段（零依赖，语义召回弱）。

### 9.4 进 Phase 3 前的待办

1. **代理恢复** → 跑完剩余 170 篇全文抓取（`--prepare` → paper-fetch → `--ingest`）；
2. **宿主重启一次** → 让 `cvagent_kb_extract` 行与新的 skill 根配置生效（E21），随后按 §8.6 清单收口真实端到端；
3. **额度**：2000 页/天。剩余 66 篇已抓论文约 800 页，跨天即可完成；243 篇整体约 2900 页，按天推进；
4. **embedding 来源决策**（§9.3 的三选一）——Domain Pack 的 `scoring` 与三库检索都等它。

> 2026-09-17 用户裁定：**抓取不再继续**（不影响开发主线），全文抓取随时可续（脚本幂等）。

### 9.5 P3-1 三库读写面（已完成）

「三库能被会话里的 Agent 读写」是 idea 生成/打分的硬前置——在此之前只有 `scripts/*.mjs`
能读写三库，会话内没有任何工具面。本轮补齐：

| 交付物 | 内容 |
| --- | --- |
| 迁移 **v4** | 三张 **external-content FTS5 表**（`problems_fts`/`methods_fts`/`innovations_fts`，`tokenize='trigram'`）+ 每库三个同步触发器（INSERT/UPDATE/DELETE）+ 迁移时 `rebuild` 一次既有条目 |
| `TriLibrary.search()` | ≥3 字符走 FTS5（查询串整体加双引号当短语，避免 `-`/`OR`/`*` 被解析为语法）；**<3 字符或 FTS 异常回退 `LIKE`**；支持 `store` / `sourcePaper` / `limit` 过滤，跨库按 problems → methods → innovations 分组 |
| `TriLibrary.summary()` | 各库计数 + 合计 + 最近更新时间 |
| `kb` 服务 | 新增 `upsertEntry` / `searchEntries` / `getEntry` / `entrySummary`（服务面即三库读写面） |
| 工具行 `cv-agent-dsh/kb-entries` | `cvagent_kb_upsert_entry`（写，含参数校验与 ext JSON 解析）、`cvagent_kb_search`（读）、`cvagent_kb_summary`（总览：论文库/通道/提取数/三库计数）。**单列一行**是为了让角色矩阵按需授予——Reader 不该有三库写权限 |
| 测试 | `tests/trilibrary.test.ts` 扩到 **13** 条（+7 条检索：中文 3 字命中、2 字回退、英文大小写不敏感、store/source/limit 过滤、FTS 语法字符不炸、触发器同步含 UPDATE 幽灵词清除、summary）；新增 `tests/kb-entries.test.ts` **6** 条（真实 ToolRuntime：目录契约、新建→检索→计数、合并语义、三类参数校验、过滤、summary 含论文面） |
| 生产库实测 | `data/papers/metadata.db` 迁移到 v4，104 条条目索引一致（14/14、21/21、69/69）；`scripts/check-trilibrary-search.mjs` 逐条验证真实检索 |

**新增的两条 L1 认知**：

1. **中文检索必须用 trigram，且必须保留 LIKE 回退**——trigram 对 **2 字查询**无效（S4 spike 实测），
   而「泛化」「部署」「鲁棒」这类两字词恰恰是最常用的检索词。只做 FTS5 会让 2 字查询
   **静默返回空**，看起来像"库里没有"，实际是索引查不到。
2. **external-content FTS5 + 触发器**比 contentless 更稳：`rebuild` 随时可从基表重建索引，
   迁移里就能把既有条目一次补齐，不需要维护镜像表；代价是 UPDATE 触发器必须显式
   `'delete'` 旧行再插新行，否则会留**幽灵词**（已由测试钉住）。

---

## 10. P3-2 Domain Pack（草案已生成，**待人工评审冻结**）

pack 承载一切「随细分领域变化」的东西（v1.2 §3.4/§18）：扩展字段、术语词典、
benchmark 清单、打分权重。它在 Phase 3 里的地位是**闸门**——`FrozenDomainPack.scoring`
是 idea 打分的权重来源，而冻结按设计**必须带人工评审签名**（`freezeDomainPack` 在签名为空时
直接抛错，类型级强制「空签名 = 跳过评审」）。

### 10.1 已交付

| 交付物 | 内容 |
| --- | --- |
| `scripts/bootstrap-pack.mjs` | 从 `metadata.db` **实测派生**草案：`schema_ext` ← 三库条目真实用过的 ext 键与取值分布；`benchmarks`/`metrics` ← 21 篇提取的频次（含数据集别名归一、指标同义词归一、通用视觉数据集排除）；`lexicon` ← 领域规范术语 + 检索改写组；`scoring` ← v1.2 §18.4 的 Deepfake 默认权重 |
| `data/packs/deepfake-detection-0.1.draft.json` | 草案（含 `provenance` 段：全部派生统计，供评审人核对） |
| `scripts/review-pack.mjs` | 评审视图（逐节打印要点，不必读 700 行 JSON） |
| `scripts/freeze-pack.mjs` | **冻结门**：契约校验（字段类型/enum 有值/权重合计 100/档位连续且覆盖 0–100）→ 强制 `--reviewer` 签名 → 写冻结产物 + 记 `domain_packs` 注册表 +（可选）`project_pack_binding` 绑定；**已冻结版本拒绝覆盖**（改 pack 必须升版本） |

### 10.2 草案要点（2026-09-17 状态）

- **pack**：`deepfake-detection@0.1`，种子论文 20 篇（已解析语料）
- **schema_ext**：problems 3 字段（`detection_target` text、`modality` enum[6]、`benchmarks` text）、
  methods 4 字段（`paradigm` enum[11]、`backbone` text、`training_strategy` enum[7]、`generalization_target` enum[5]）、
  innovations 1 字段（`innovation_type` enum[7]）。enum 取值 = **语料实测值 ∪ 领域标准词表**（统一 snake_case），
  避免「没人填过但显然该允许」的值被挡在外面
- **benchmarks 18 个**：识别出的规范数据集**一律纳入**（含语料里只出现 1 次的音视频集
  LAV-DF/AV-Deepfake1M/KoDF/FakeAVCeleb——按频次卡掉会让 pack 丢掉整个音频分支）；
  未识别的自由文本名要求 ≥2 篇提及；通用视觉数据集（ImageNet/COCO/ADE20K）与音视频**预训练语料**
  （VoxCeleb2/LRS2）排除并留痕
- **metrics 9 个**：AUC / ACC / AP / F1 / EER / Precision / Recall / FLOPs / Params（同义词已归一）
- **protocols 4 条**：in_domain / cross_dataset / cross_manipulation / cross_model
- **lexicon**：15 术语 + 8 检索改写组
- **scoring**：`30/30/25/15`（novelty_problem / novelty_method / novelty_combo / feasibility），
  `high_risk_similarity=0.85`、`topk=10`，档位 `proceed [75,100] / revise [50,74] / abandon [0,49]`

### 10.3 冻结命令（评审通过后执行）

```bash
node scripts/freeze-pack.mjs --reviewer "<评审人标识>" --bind
```

> 冻结前请重点看三处：**enum 词表**（它决定未来 Analyst 抽取的取值空间）、
> **benchmarks 纳入/排除清单**（`provenance` 里两组都在）、**权重与档位**（决定 idea 打分口径）。

---

## 11. P3-3 Idea 生成与打分：LLM 与确定性算法的分工（2026-09-17 需求细化）

用户提出的问题：「idea 生成、打分其实需要 LLM 参与推理，现在是这样吗？」
**事实**：此前一行实现都没有——`core/src/scoring/idea.ts` 只是契约，`mcp-server` 只是占位清单，
`ideaScore` 服务与 `cvagent_idea_*` 工具都不存在。契约里已经留好 LLM 的接入点
（`IdeaScorer` 是注入式接口；`rationale` / `SimilarPaper.reason` 的注释写明「LLM 复核产出」）。

### 11.1 用户裁定（2026-09-17）

| 决策 | 选择 |
| --- | --- |
| 生成方式 | **N 个不同视角的 Generator 子代理并行生成 → 语义合并去重**（而不是主 Agent 一次生成） |
| 裁判方式 | **单个 LLM 裁判 + 检索证据**（裁判必须指名撞哪一条；数值由 core 算） |
| 撞车范围 | **本地三库/论文库为主，相似度落在边界带时才外扩 Asta 外部检索** |

### 11.2 分工表（谁做哪一步）

| 环节 | 归属 | 理由 |
| --- | --- | --- |
| 候选召回（三库 + 论文库） | **确定性**（当前 FTS5，embedding 落地后升级） | 可复现、可审计；`retrieval_mode` 降级标记的所在 |
| 相似度**数值** | **确定性**（见 §11.5 的两模式方案） | pack 的 `high_risk_similarity=0.85` 只有对确定性数值才有意义 |
| idea 生成（问题×方法重组 / 找 gap） | **LLM**（N 个视角 Generator，委派） | 综合创造，规则写不出来 |
| 语义撞车判定 | **LLM 裁判 + 检索证据** | 检索只给候选，判定要读内容 |
| `feasibility`（实验可行性） | **LLM 裁判** | 依赖对 baseline/评测设计的判断 |
| `rationale` / 撞车理由 | **LLM 裁判** | 自然语言解释 |
| 加权聚合 + 档位映射 | **确定性纯函数（core）** | 分数必须可复算 |
| idea 选型人工门 | **主 Agent 走 §4.3 三段式** | 子代理不能发起审批（E15），只能父层做 |

### 11.3 三条硬规则

1. **生成者 ≠ 裁判**：不同委派、独立上下文、互不可见对方材料。同一个 LLM 既生成又打分必然**自评自夸**（对自己的产出系统性给高分）。
2. **裁判只做证据锚定的判定，数值由 core 算**：每条撞车必须给 `entry_id`/`paper_id` + 撞车理由 + 判定（碰撞/不碰撞）；四个维度分值由确定性函数从「检索证据 + 裁判判定」算出。
3. **报告自包含、可复算**：`ScoringReport` 必须携带复算所需的全部输入（各维度的检索命中与分数、裁判的逐维判定与理由、外扩检索是否发生、检索模式），使得「为什么这条 idea 得 82 分」在事后可**逐位重算**，且同一输入两次打分结果一致。

### 11.4 执行形态（委派图）

```
cvagent_idea_generate
  └─ 视角 = 冻结 pack 的 problems × 方法范式（领域相关内容都在 pack 里，原则六）
     ├─ spawn Generator#1（视角 A：toolFilter = kb 检索面；outputSchema = IdeaCandidate[]）
     ├─ spawn Generator#2（视角 B）
     └─ … N 个并发
  └─ 合并去重：statement 归一化 + 视角标记保留（记为 candidate.lens）

cvagent_idea_score
  ├─ 1) ideaScore 服务：确定性召回（problems/methods/论文库）+ 相似度估计 + 组合共现检测
  ├─ 2) 边界带判定 → 命中则外扩 Asta（外部检索，结果标记 escalated）
  ├─ 3) spawn Judge 子代理（outputSchema = 逐维判定 + 证据 ID + 理由）——**与 Generator 无共享上下文**
  ├─ 4) ideaScore 服务：确定性聚合（权重来自冻结 pack）→ ScoringReport
  └─ 5) 主 Agent 呈递 gate（proceed / revise / abandon 三档）
```

### 11.5 关键发现：相似度标定必须自带（否则阈值失效）

现有检索**给不出 [0,1] 的相似度**：FTS5 的 `rank` 是无界负值（bm25 变体），`LIKE` 回退根本没有分数。
而 pack 冻结的 `high_risk_similarity=0.85`、边界带、三档映射都要求可比数值。因此打分器必须自带有标定的估计：

| 模式 | 相似度来源 | 标记 | 说明 |
| --- | --- | --- | --- |
| `vector` | embedding 余弦 ∈ [0,1] | 首选 | 需先定 embedding 来源（§9.3 三选一，仍未定） |
| `keyword_only` | **核心自带**：字符 trigram Jaccard（中文自动退化为纯 trigram，避免整句当一个 token） | **降级**（`retrieval_mode: 'keyword_only'`） | 零依赖、可复现；对同义改写盲（见下），但数值有界可比 |

**用真实语料做的标定**（`scripts/calibrate-similarity2.mjs`：69 对「Analyst 条目 ↔ 其来源论文的创新点原文」当正例，
69 对「条目 ↔ 其它论文的创新点」当负例）：

| 阈值 | 正例召回 | 负例误报 |
| --- | --- | --- |
| ≥0.10 | **62%** | 1/69 |
| ≥0.15 | 30% | 0/69 |
| ≥0.30 | 10% | 0/69（此档基本是「同文」） |

正例分布 p50=0.124 / p90=0.271 / max=0.548；负例 p50=0.040 / p99=0.094 / max=0.135。

→ 两条结论：

1. **阈值必须按模式区分**：把余弦口径的 `0.85` 套到 keyword 模式会**严重漏判**（负例最大才 0.135）。
   pack 因此同时给出两套：`high_risk_similarity: 0.85`（vector）+ `keyword_only:
   { related_similarity: 0.10, near_duplicate_similarity: 0.30, boundary_band: [0.10, 0.30) }`。
2. **keyword 模式有致命盲区，且是量化的**：语义相同但措辞不同的一对陈述，相似度实测 **0.0**
   （「深伪检测的跨数据集泛化能力不足」vs「检测器在未见生成方法与分布偏移下性能下降」）。
   检索侧**永远召不回**它们——所以「语义撞车」只能由 LLM 裁判负责，这不是可选优化，
   而是 §11.2 分工表里裁判存在的**根本理由**。测试已把该盲区如实钉住
   （`core/tests/score.test.ts` 的「同义改写相似度为 0」用例）。

→ 结论：**Phase 3 可以先在 `keyword_only` 模式下跑起来**（阈值/档位/边界带都有效且是实测标定的），
embedding 到位后同一套契约自动升级到 `vector` 模式。embedding 决策从「阻塞项」降级为「质量升级项」——
它现在的收益是**把裁判的召回负担接过去一部分**，而不是让系统能跑。

### 11.6 待定参数（实现时给默认值，可在 pack 里调）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `generators` | `min(problems 数, 6)` | 视角数 N；越多越多样，成本 ≈ N× |
| `ideas_per_generator` | 3 | 每个视角产出的候选数 |
| `boundary_band` | `[0.70, 0.90]` | 相似度落在此区间才外扩 Asta（低于=不撞，高于=直接判撞） |
| `max_ideas_scored` | 10 | 单轮打分上限（控制裁判成本） |
| `judge_model` | 与 Orchestrator 同路由 | 若后续要更强的独立裁判，可在此处换模型 |

### 11.7 P3-3a 已交付（本轮）

| 交付物 | 内容 |
| --- | --- |
| 契约扩展（`core/src/scoring/idea.ts`） | `CollisionEvidence`（ref_id / source / excerpt / similarity / verdict / reason）、`DimensionScore`（`retrieval_baseline` + `final` + `adjusted_by_judge`）、`ScoringReport` 追加 `dimension_trace` / `evidence` / `weights_snapshot` / `escalated_external` / `judged_by` / `judged_at`；`IdeaCandidate` 追加 `lens` / `generated_by`；`ScoringThresholds` 支持**按模式区分**阈值 |
| 确定性算法（`core/src/scoring/score.ts`） | `lexicalSimilarity`（trigram Jaccard，中文自适应退化）、`deriveEvidence`（基线分 + 边界带）、`applyJudgment`（裁判判定 → 维度分，**裁判不能凭空报数**：撞车封顶 20、表面相似剔除、可行性采用裁判值且越界回落）、`totalScore`、`classifyBand`、`classifyRisk`（按模式取阈值）、**`recomputeTotal`**（报告自包含可复算的可执行判据） |
| 标定脚本 | `scripts/calibrate-similarity.mjs`（第一轮，共享论文当正例——**证明该代理指标无效**）、`calibrate-similarity2.mjs`（第二轮，paraphrase 真值，产出上表阈值） |
| 测试 | `core/tests/score.test.ts` **19 条**：相似度有界/对称/归一化不变、中文语序、**同义改写盲区（=0）如实钉住**、基线分定义（无证据不给满分）、边界带三态、backend_score 优先、裁判四类影响、权重与档位、风险级按模式、报告可复算（换权重快照结果随之变化） |

**下一增量（P3-3b）**：`ideaScore` 服务（preset，读 `kb`）把上面的纯函数接到真实检索上；
`cvagent_idea_generate`（N 视角 Generator + 合并去重）与 `cvagent_idea_score`（召回 → 边界带外扩 Asta → 委派裁判 → 聚合）；两者各配「假 subagents 提供者」的契约测试（同 `kb-extract` 的做法）。

### 11.8 裁判（Judge）规格：用户提案 + 六条硬约束（2026-09-17）

用户提案：「把我们资料库中的必要信息组装入上下文，分发给一个子代理，由子代理对比这些方法，
判断是否撞车」——**这正是设计中的裁判形态**。但要让它的结论可用（可复现、可审计、不被单次
随机性带偏），必须补六条约束：

| # | 约束 | 理由 |
| --- | --- | --- |
| 1 | **进上下文的证据由确定性检索决定**，不由裁判决定看什么 | 否则同一条 idea 两次判定的**输入**都不同，结论无法复现 |
| 2 | 证据包 = 每条候选的 `entry_id` + 陈述 + `ext` 关键字段 + 相似度 + 来源标记（本地/外扩），**top-k**（默认 k=10）；不灌全库 | 全库进上下文会爆炸且稀释判断力；k 与阈值都在 pack 里 |
| 3 | 输出必须是**逐条判定**：`{ref_id, verdict: collision\|superficial, reason, confidence?}`——不是全局一句"撞车/不撞车" | 分数要按维度（问题/方法/组合）分别算，且要能审计到具体条目 |
| 4 | **生成者 ≠ 裁判**：独立委派、独立上下文、互不可见对方材料 | 同一个 LLM 既生成又打分必然自评自夸（§11.3 规则 1） |
| 5 | 允许**一轮**受限追问：裁判可请求某条目的完整陈述或来源论文摘要；第二轮即产出结论，不可无限追问 | 证据片段可能不足以判断，但循环追问会让成本与延迟不可控 |
| 6 | 高风险候选（总分落在档位边界或 `needs_external` 为真）可**跑两次裁判**，判定分歧则升级为人工 gate | 单次 LLM 判定有随机性；这是"重要决策二次确认"的最低成本形式 |

裁判看到的上下文构造（`cvagent_idea_score` 内部）：

```
[候选 idea]
statement / problem / method / innovation / baselines

[证据包：本地检索 top-k]
P002 (problems, sim=0.31) 跨数据集与跨伪造手法的泛化：…
M015 (methods,  sim=0.18) CLIP-LN-tuning 检测器：…
F021 (failures, sim=0.22) SFIAD：计算效率是弱点…

[证据包：外扩检索（仅当 needs_external）]
Asta: 2345.67890 (sim=?, 标题/摘要) …      ← 标记 external=true

[任务] 对每条证据判定 collision / superficial，给理由；不要给总分（总分由 core 算）
```

> 打分器侧已就绪：`applyJudgment()` 只接受逐条判定，撞车维度封顶 20 分、表面相似剔除、
> 可行性采用裁判值且越界回落；`recomputeTotal()` 保证报告可复算（`core/tests/score.test.ts` 19 条）。

### 11.9 P3-3b 已交付（2026-09-17）

| 交付物 | 内容 |
| --- | --- |
| `ideaScore` 服务（preset，与 `kb` 同 realm） | pack 装载（**冻结产物优先、回落草案、未冻结如实标记**；两者都缺直接报错"没有权重的打分没有意义"）、四库召回、证据派生、裁判上下文组装、确定性聚合、`verify()` 复算校验 |
| `cvagent_idea_generate` | N 视角并发 Generator（视角缺省取自问题库）→ 跨视角**合并去重**；每个视角的状态如实区分 `ok / duplicate / empty / error`（"想出来了但别人说过"与"确实没方向"是两种信息）；委派契约：`spawn` + `toolFilter={cvagent_kb_search,cvagent_kb_summary}` + `maxDepth:0` |
| `cvagent_idea_score` | 本地召回 → **边界带命中则返回 `needs_external_evidence`**（外扩检索由主 Agent 用 `mcp__asta__*` 执行后回传，因为工具不能调用别的工具）→ 委派裁判（逐条判定 + feasibility + 总分理由；**不给四维分值**）→ 确定性聚合 → 失败库复查结论（`blocked_by` / `waivers`） |
| 工具行落位 | 两行加进 `cvagent-kb-group`（**不能另起 group**：那会在同一 DB 上得到第二个 kb 实例，两份缓存、语义分叉） |
| 测试 | `tests/idea-service.test.ts` **8 条**（pack 三态、四库召回、派生、聚合与自洽、失败库 blocked/waivers、裁判上下文）+ `tests/idea-tools.test.ts` **8 条**（目录契约、生成合并与四态、缺视角回退、打分全链、外扩往返、契约刚性两条）。dsh-plugin 测试数 **86 → 102** |

**顺带修掉一个会造成系统性假阴性的检索 bug（重要）**：

`TriLibrary.search` 原先把整个查询串当**短语**交给 FTS5（`"整句话"`）。对 idea 打分用的
「问题 + 方法」组合长串，短语在任何文档里都不可能连续出现 → **恒为空**；而空结果不抛异常，
于是静默返回"库里没有相关工作"。后果是**每一条 idea 都会因"查不到撞车"而虚高**。

修复：`compileFtsQuery()` 把查询拆成词项后 `OR`（中文按 3 字滑窗，与 trigram 粒度对齐；
<3 字符项交给 LIKE 回退），并且**FTS 命中为空时再走一次 LIKE**。生产库实测：

```
[组合查询] 跨数据集泛化不足 频域分支替换 → problems: P011,P002  innovations: I009,I030  failures: F015,F032
[组合查询] 可解释性缺失 CLIP 适配器       → problems: P004,P012  innovations: I020,I065  failures: F067,F065
```



---

## 12. 需求细化（二）：检索 / 三库 / Idea / 实验四段的现状与设计（2026-09-17）

用户按四段提出细化需求，并要求「先讲现在怎么实现的」。以下逐条对齐**事实**（截至 commit `16aab6c`）。

### 12.1 现状对照

| 段 | 已有 | 缺什么 |
| --- | --- | --- |
| **(1) 检索文章**：对话定细分领域 → 提关键词 → 检索 | Asta 8 工具真实可用（P2-7 实测取回 244 篇）；`SCOUT_ALLOWED_TOOLS` 白名单已声明；pack 的 `lexicon`（15 术语 + **8 组 `query_expansion` 检索改写**）就是"关键词扩展"的载体；入库工具 `cvagent_kb_import_paper`（三级去重）已实现 | ① **Scout 委派工具**（白名单声明了但没有工具去 spawn Scout）；② **"对话定细分领域"的流程**（persona 未写、状态机无 `sub_domain` 字段）；③ 关键词→检索→入库的编排（当前由脚本 `asta-control.mjs` 承担，不是会话内能力） |
| **(2) 提取三库**：结合论文库准确提取归纳 | Reader 提取工具 `cvagent_kb_extract`（20 篇真实跑通 + 6 条契约测试）；三库读写工具 `upsert_entry/search/summary`；三库检索 FTS5+LIKE；Analyst 归纳**已跑通但只是脚本流程**（digest 文件 → 子代理 → `load-entries.mjs`） | **Analyst 委派工具**（把"从提取归纳出条目 + 与既有三库去重"变成会话内能力）；失败方法库（见 12.2） |
| **(3) 提出 Idea + 失败库复查 + 打分** | **只有 P3-3a 的确定性打分骨架**（相似度标定、证据派生、裁判判定应用、加权聚合、报告可复算）+ 契约 + 用户选定的三条口径（§11.1） | **idea 生成本身一行代码都没有**；失败方法库；打分工具与裁判委派 |
| **(4) 实验组织** | 状态机 experiment 阶段占位；`AuthorizedAction` 四类受限动作；服务平面裁定（原定 `expOrchestrator` 归宿主） | 归档原则（已交付，见 §12.4）；**原定的 `exp_plan/launch/status/collect` 四工具经用户裁定撤销** |

> 一句话回答「idea 生成现在怎么实现的」：**没有实现**。已实现的只有「分数怎么算」的确定性部分，
> 「idea 怎么被想出来」还是空白——因此下面 (3) 是真正要开工的地方。

### 12.2 新增需求：**失败方法库**（第四库，需评审）

用户要求：idea 提出后，**再过一遍本地一直维护的失败方法库**，然后才打分。设计要点：

| 项 | 设计 |
| --- | --- |
| 存储 | 新增同构表 `failures`（`entry_id` = `F001…`）+ FTS5 trigram 索引（**迁移 v5**），与三库同形（statement / ext / source_papers / 时间戳） |
| 内容 | 一条失败 = 「某个做法在某个条件下不成立」。statement 写"做法 → 失败表现"，例：*「在 FF++ c23 上只做频域分支替换主干：跨库 AUC 不升反降（DFDC −1.8）」* |
| `ext` 字段 | `failure_mode` ∈ `method_invalid` / `data_issue` / `metric_not_improved` / `resource_infeasible` / `reproducibility`；`conditions`（成立条件）；`evidence`（`paper:<id>` 或 `exp:<exp_id>`）；`revisit_when`（什么条件下值得再试） |
| 来源（三条，按可靠性排序） | ① **我们的实验负面结论**（`experiments/*/RESULTS.md` 的负面结论段 → 回流，归档原则 §3 规则 2 已规定）；② **论文的 limitations / 负面对比结果**（Reader 已经在提 `limitations`——21 篇提取里现成有 ~60 条，可作种子）；③ 人工录入 |
| 用途（关键语义） | idea 生成后 → **强制复查闸**：候选 idea 与 failures 检索 + 裁判判定 → 命中则**不是直接丢弃**，而是要求写明「为什么这次不一样」（`revisit_when` 对照），再进入打分。理由：失败条件是会变的（换数据集/换主干/算力变化），一刀切丢弃会扼杀正确想法 |
| 与打分的关系 | 复查结论进入 `ScoringReport.evidence`（`source: 'failures'`），并在 `risk_level` 上体现；权重不变 |

**待用户裁定的一点**：Domain Pack 是**现在就冻结 0.1**（不含 failures 段），还是**等失败库 schema 落定后一起冻结进 0.1**？
→ **2026-09-17 用户裁定：等失败库 schema 定了一起冻进 0.1**（已按此执行，见 §12.6）。

### 12.6 失败方法库已落地（2026-09-17）

| 交付物 | 内容 |
| --- | --- |
| 契约 | `StoreName` 增 `failures`；新增 `FailureEntry` 与 `KnowledgeBase.upsertFailure/similarFailures`；`STORE_ID_PREFIX`（P/M/I/**F**）成为唯一前缀来源（原先 dsh 侧各写一份） |
| 迁移 **v5** | `failures` 同构表 + `failures_fts`（trigram）+ 三个同步触发器。生产库已迁移：`1,2,3,4,5`，索引一致 |
| 服务/工具 | `TriLibrary.search/summary/counts` 覆盖四库；`cvagent_kb_upsert_entry` 与 `cvagent_kb_search` 的 store 枚举含 `failures`；`cvagent_kb_summary` 输出 `entries_failures` |
| 种子（来源②） | `scripts/seed-failures.mjs` 从 21 篇提取的 `limitations` 派生 **67 条**（F001–F067），`ext` 带 `failure_mode` / `conditions` / `evidence: paper:<id>`。已装载：库内 **171 条**（P14/M21/I69/F67） |
| 失败模式分布 | `other` 31 / `data_issue` 15 / `metric_not_improved` 12 / `reproducibility` 3 / `resource_infeasible` 3 / `method_invalid` 3 |
| 包 | Domain Pack 草案新增 `schema_ext.failures`（4 字段）+ `failure_mode` 规范枚举；并新增 **`DECLARED_FIELDS`** 机制——把「设计上要有、但语料里还没人填」的字段显式补进 pack（`revisit_when`、`related_problem_ids`、`related_method_ids` 就是这样回来的） |

**两处如实记录的局限**：

1. `other` 占 46%：**机械分类只能到这个程度**。失败模式本身是判断（"指标没升"与"方法无效"的界限要看语境），
   因此种子里的 `other` 应由 Analyst/人工在后续轮次订正，不要假装它已分类完成。
2. `revisit_when` **全部留空**：该字段要求判断"失败条件是否已变"，机械填充等于编造。留空即"尚无人评估过复现条件"。  

### 12.3 检索段的补全（对应 (1)）

| 交付物 | 内容 |
| --- | --- |
| 状态字段 | `ProjectState` 增 `sub_domain`（细分领域一句话）+ `keywords`（关键词组），由**对话确定后落盘**（与 §4.3 门控同一套持久化） |
| 对话流程 | Orchestrator 用 `ask_user_question` 与用户收敛细分领域 → 用 pack 的 `lexicon.query_expansion` 展开关键词 → 落盘 `sub_domain`/`keywords` |
| Scout 委派工具 | `cvagent_kb_scout`：spawn Scout 子代理（`toolFilter = SCOUT_ALLOWED_TOOLS`，outputSchema = 候选论文列表：title/ids/year/venue/相关性一句），返回后由主 Agent 调 `cvagent_kb_import_paper` 入库（保持检索与写入职责分离） |
| 判据 | `knowledge_building` 阶段的完成判据从「非空摘要」升级为：论文库 ≥ N、三库条目 ≥ M、抽检通过（当前判据是 Phase 1 占位，见 `state/tools.ts`） |

### 12.4 实验段：决策变更（对应 (4)）

**用户裁定**：不写实验编排服务；只写「文件组织归档原则」，把设计与执行交给 dsh（它本身就是
coding harness agent），我们只提供上下文/项目背景。

- **撤销**：`IDEA_TOOLS` 里的 `exp_plan` / `exp_launch` / `exp_status` / `exp_collect` 四个工具名
  与「`expOrchestrator` 宿主服务」的既有计划（§4.4.1 的服务平面裁定的对应条目作废，其余不动）。
- **保留**：§4.6 的授权门（GPU 实例 / 计费 API / 破坏性操作仍须主 Agent 在委派前取得授权，E15 不变）。
- **交付**：`docs/实验归档与组织原则.md`（目录结构 / 命名 / 三条硬规则 / 与状态机衔接 / 最小上下文包）
  + `scripts/check-experiment.mjs`（**只读校验**：README 必备小节、每个 run 的 `cmd/env/metrics` 三件套、
  RESULTS 负面结论小节、EVIDENCE 每行可溯源、INDEX 登记）
  + `experiments/`（`INDEX.md` + `_template/` + `.gitignore` 排除 checkpoint 等大产物）。
- **为什么不校验就等于没有**：原则若无校验脚本，就只是愿望；`--all` 已实测能对缺件目录报 FAIL。

### 12.5 需要用户评审的事项（怎么看、看什么、怎么判）

| # | 事项 | 看哪里 | 判断标准 | 通过后我的动作 |
| --- | --- | --- | --- | --- |
| 1 | **失败方法库 schema（迁移 v5）** | §12.2 的表；重点是 `failure_mode` 枚举与「命中不丢弃、要求写为什么这次不一样」这条语义 | ① `failure_mode` 五类是否覆盖你关心的失败形态；② 是否同意"复查而非丢弃"；③ 是否同意三条来源（我们的实验 / 论文 limitations / 人工） | 写迁移 v5 + FTS5 + `TriLibrary` 扩展 + 从 21 篇提取的 `limitations` 派生种子条目 |
| 2 | **Domain Pack 冻结**（先并入失败库再冻，还是先冻 0.1） | `data/packs/deepfake-detection-0.1.draft.json`；命令 `node scripts/review-pack.mjs`（要点视图）与 `--dry-run`（契约校验） | 三处：**enum 词表**（决定 Analyst 取值空间）、**benchmarks 纳入/排除清单**（`provenance` 段有两组全量）、**权重 30/30/25/15 与档位、按模式的阈值**（keyword 模式 0.10/0.30 是实测标定值） | `node scripts/freeze-pack.mjs --reviewer "<你的标识>" --bind` |
| 3 | **实验归档原则** | `docs/实验归档与组织原则.md`：§2 目录结构、§3 三条硬规则、§5 校验项 | ① 目录/命名是否够用且不啰嗦；② 三条硬规则（数字溯源 / 失败也归档 / 可原地重跑）是否同意；③ 校验项是否要增删 | 把该约定接进 preset 的 prompt 章节（让会话里的 agent 知道去哪找、必须交什么） |
| 4 | **P3-3b 工具行为**（生成/打分/复查） | 尚未实现；实现后看 `tests/` 的契约测试 + 一次真实小规模跑（建议 2 视角 × 2 条 = 4 个候选） | ① N 视角的取法（我建议：视角 = 冻结 pack 的 `problems` × 方法范式，每视角产出 k 条）；② 失败库复查的判定标准；③ 是否接受 `keyword_only` 模式下的打分（语义撞车全靠裁判） | 实现 `ideaScore` 服务 + 三个工具（scout/analyst 之外）并给出真实跑批报告 |

---

### 12.7 P3-4 已交付（2026-09-17，用户批准的三项）

按用户裁定「1、2、3 全做」，三处缺口一次补齐：

| # | 交付物 | 内容 |
| --- | --- | --- |
| 1 | **检索段闭环** | ① 状态新增 `sub_domain` / `keywords`（core `setResearchScope` 纯函数归一化；空串与未设置归一到同一状态）+ 工具 `cvagent_scope_set`（6 个状态工具）；② **`cvagent_kb_scout`**：按范围委派 Scout 子代理（`toolFilter = SCOUT_ALLOWED_TOOLS`，**刻意不含 `snippet_search`**——Scout 只回候选），候选形状校验后返回，并把可入库子集打成 `import_json`；③ **`cvagent_kb_import_papers`**：批量入库，逐条回传 inserted/merged/needs_review/error（**部分成功是正常结果**）。检索与写入职责分离：Scout 不写库 |
| 2 | **Analyst 工具化** | **`cvagent_kb_analyze`**：确定性构造去重上下文（该批提取的既有相关条目 + 提取内容）→ 委派 Analyst（只给 `cvagent_kb_search/summary` 只读）→ 提案形状校验（缺 `source_papers`/库名非法一律丢弃并计入 `skipped`）→ 按 §7.5.2 规则写入；`dry_run=true` 只回提案供复核 |
| 3 | **阶段判据升级** | 判据从「非空摘要即完成」的占位升级为**真实数字判据**（core `evaluateCriteria` + `DEFAULT_CRITERIA`）：论文 ≥100、已解析 ≥50、提取 ≥20（P2-7 抽检口径）、四库条目 5/5/10/5，且 **`sub_domain` 未确定则一律不放行**；`advance` 回传 `facts_json` 供核对。事实由状态服务从 `kb` **直接读取**——模型没有机会自报数字 |

**两处架构性改动（都在组合与契约层面，值得记住）**：

1. **两个 isolate group 合并为一个** `cvagent-project-group`（`isolate: { projectState: true, kb: true }`）。
   原因：`advance` 的判据必须读知识库真实数字，而**跨 realm 解析不到**——分着放，
   判据就只能退化成"模型自报"，门控等于没有。合并同时消除"同一 DB 两个 kb 实例"的隐患。
2. **`StageFacts` 由外部注入 core**：core 保持纯同步（`evaluate` 不变异步），
   事实在服务层**先采集、再判定**。这条边界让判据既能吃真实数字，又不把纯逻辑层污染成异步接口。

**顺带补掉一个"门控永远不会达标"的隐患**：`collectFacts` 里 `parsed` 与 `experiments` 起初没有数据源
（`kb.parsedCount()` 不存在、`experiments/` 没人数），表现为**判据恒不满足**而表面一切正常。
现已补 `KbService.parsedCount()` 与"`experiments/<id>/RESULTS.md` 存在即算收敛"的口径
（与 `check-experiment.mjs` 一致）。

**测试**：`core/tests/criteria.test.ts` 10 条（范围归一化、四库分别把关、缺什么说什么、阈值可覆盖、后续阶段）；
`packages/dsh-plugin/tests/kb-research.test.ts` 8 条（Scout 契约与无标识候选过滤、批量入库部分成功、
Analyst 去重上下文与提案校验、dry_run）；`tests/state-tools.test.ts` 重写为 15 条（真实数字判据 +
scope_set + idea 计数 + 实验收敛口径 + 三模式达标流水线）。计数：core 53、dsh-plugin 114。

### 12.8 P3-5 已交付：Domain Pack 工具化（2026-09-17）

把 pack 的**生命周期**从脚本搬进会话，并把治理规则做进工具面——工具面补齐到 **20 个**（剩 5 个声明未接线：exp 4 已撤销 + `write_draft`）。

| 工具 | 作用 | 治理点 |
| --- | --- | --- |
| `cvagent_domain_bootstrap` | 从当前知识库派生草案落盘 | 派生**确定性**（同输入同草案，测试钉住）；草案可反复覆盖，**不是权威** |
| `cvagent_domain_freeze` | 冻结 | **必须带 `reviewer` 签名**；契约校验前置；**同版本拒绝重复冻结**（改 pack 必须升版本） |
| `cvagent_domain_propose_revision` | 基于已冻结版本 + 当前知识库派生**新版本** + **差异摘要** | 修改 pack 的唯一合法入口；评审人看"改了什么"而不是整份新 pack |
| `cvagent_domain_bind` | 项目绑定到某已冻结版本 | 只接受**已冻结**版本（草案不可绑）；换绑回传旧绑定 |

**三个实现要点（都是为了消灭"两套实现迟早分叉"）**：

1. **派生与校验逻辑只有一份**：`pack-builder.ts`。两个 CLI（`bootstrap-pack.mjs` / `freeze-pack.mjs`）
   改成薄壳调用同一模块；会话内工具也调它。此前脚本各写一套——"契约校验"那几十行规则一旦不一致，
   就会出现「脚本说能冻、工具说不能」这类最难查的问题。
2. **SQL 也只有一份**：`loadPaperRows` / `loadExtractionIds` / `loadEntryRows` 由插件与脚本共用；
   数据源统一为 `metadata.db`（不再读中间产物 JSON）。
3. **注册与落盘同处发生**：`domain_packs` / `project_pack_binding` 两张表在 metadata.db，
   登记方法做在 `kb` 服务上——避免"文件在、注册表没有"的分叉。

**测试抓到三个真 bug（写测试的价值就在这里）**：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 派生的 `schema_ext` 空 | ext 的包键被硬编码成 `deepfake-detection`，忽略配置 | `packNamespace` 作参数，**缺省等于 `pack_id`**（命名空间约定） |
| `bootstrap --version 0.2` 写出 ref=0.1 的草案，冻结后污染注册表 | `derive()` 读配置默认值、忽略工具参数 | `derive(packId, version, …)` 显式传参 |
| `backbone` 被固化成 `enum[1]`（只观测到 CLIP 一个值） | "取值少即枚举"的判据太激进 | 收紧：有规范词表才算 enum，否则**至少 3 个不同取值**——枚举是约束，不能从一两个样本发明 |

新增测试 12 条（`tests/domain-tools.test.ts`）：派生确定性、schema_ext 反映真实 ext 用法、
空签名被拒、契约不通过被拒、同版本拒绝重冻、修订差异、绑定只认已冻结版本。

---

### 12.9 preset 挂载事故（E30）与两道守卫（2026-09-17）

工具面补到 21 个之后，用户在界面上切换 preset 直接失败：

```
无法切换到「CV Research Orchestrator」：
failed to apply loader entry cvagent-instructions (cv-agent-dsh/instructions):
cannot get property "systemPrompt" without inject
```

`src/instructions.ts`（项目约定 prompt 章节，§12.4 里刚加的常驻章节）访问 `ctx.systemPrompt`
却没有声明 `inject: ['systemPrompt']`。**根因一句话**：Cordis 要求按属性访问服务前先声明依赖，
而这条规则是在**装载行**时才检查的——所以症状是"整个 preset 不可用"，不是"少了一行约定"。

#### 这个事故有**两层**，第一层修完仍然照原样报错

第一层：没声明。于是加上 `export const inject = ['systemPrompt']`——**重启后用户报"还是同样的错"**。
这提醒了一件必须记住的事：**报错不变不等于没修，也不等于修错了，而是修到了另一层。**

第二层（真正的坑）：**声明写在哪一侧，决定了它算不算数。** `cordis-plugin-loader` 每装载一行都走

```js
// lib/index.js:745
unwrapExports(exports) {
  exports = exports.default ?? exports   // ← 有 default 就只认 default
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
// Entry._init / Entry.update：
plugin = this.loader.unwrapExports(await this.tree.import(this.options.name, ...))
```

本文件当时写着 `export default apply`（**一个普通函数**）。于是 loader 拿到的插件是那个**函数**，
函数上没有 `inject`，`export const inject` 被整个丢弃——加了等于没加。三种形态对照：

| 模块形态 | 解包后的插件 | inject 从哪读 | 本包实例 |
| --- | --- | --- | --- |
| 只有命名 `apply` / `inject` / `name` | 模块命名空间对象 | 命名 `inject` ✅ | 8 个工具行 |
| `export default class extends Service` | 那个类 | `static inject` ✅ | 3 个服务行 |
| `export default apply`（普通函数） | **那个函数** | 函数自身的 inject；**命名 `inject` 被丢弃** ❌ | `instructions.ts`（已改掉） |

**修法**：`instructions.ts` 去掉 `export default`，与 8 个工具行同形（只留命名导出），
并在文件里写明"不要在这里加 default"。E18-② 的原话——"必须有 `default`（插件类）**或**命名
`apply` 导出"——说的是"两者之一即可被**装载**"，**没有**说"两种形态下 inject 的读取位置相同"。
这条歧义正是事故的第二层。

#### 为什么全套测试没抓到（这才是真正的教训）

`tests/instructions.test.ts` 里有这么一段：

```js
const fork = await app.plugin({
  name: 'conventions',
  inject: ['systemPrompt'],   // ← 测试自己写了一份声明
  apply(ctx) { instructions.default(ctx, { repoRoot: '.' }) },
})
```

测试**替被测对象补齐了它缺失的那份声明**，于是永远通过。它验证的是"这个 apply 函数
在被正确声明的前提下能不能工作"——而生产挂载问的是另一个问题："这个模块**自己**的声明够不够"。
**测试一旦承担了被测对象的责任，就测不出被测对象的失职。** 一切"插件声明契约"的测试都必须
让被测对象以**它自己的声明**去挂载。

第二条更隐蔽：**探针也犯了同一个错**。第一版探针从模块的命名导出取 `inject`，再手动塞给插件
（`{ name, inject: declaredInject(mod), apply: mod.default }`）——于是"有 default 时命名 inject 被丢弃"
这条 loader 语义又被探针补上了，`instructions.ts` 在探针里显示"挂载成功"。
现在探针原样复刻 `unwrapExports`，只把 `module.default ?? module` 交给 Cordis，**不补任何声明**。

#### 两道守卫（都已做"能失败"验证）

| 守卫 | 形态 | 抓什么 | 双向验证 |
| --- | --- | --- | --- |
| `tests/row-inject.test.ts` | 静态：扫 `src/**/*.ts` 行模块，按 **`unwrapExports` 规则**算"有效声明"（有 default 时命名导出作废），再要求每个 `ctx.<service>` 访问都落在有效声明里；扫描前先剥注释 | 漏声明 + **声明写在会被丢弃的那一侧**（整份挂载失败这一类） | 删掉命名 `inject` → 红；把 `export default apply` 加回来 → 红（"有 default 导出的行模块"用例）；还原 → 绿 |
| `scripts/probe-preset-rows.mjs` | 运行期：**新进程**里用**真 Cordis** + **loader 的 `unwrapExports`**，逐行挂载 preset 里 13 个本包行，自己不补任何声明 | 上述两类 + 模块导入失败 + apply 抛异常 | 删掉命名 `inject` → 该行抛 `cannot get property "systemPrompt" without inject`（**与生产报错逐字相同**）12/13；恢复 `export default apply` → 同样 12/13；修好后 → 13/13 |

**为什么探针必须在独立进程**：宿主的 ESM 缓存按 URL 命中（E21）。宿主一旦导入过
`lib/instructions.js`（哪怕当初 apply 失败），进程内再也读不到重建的版本——在宿主里复查只会
重放旧模块的旧错误。探针因此自带 `?probe=N` 缓存击穿，并且只在**独立进程**里可信。

#### 探针踩的第二个坑：桩挂在哪

第一版探针用 `app.provide('systemPrompt', stub)` 在**根上下文**上挂桩，结果**变异测试没红**：
把 `inject` 删掉，那一行照样"挂载成功"。实测四种形状后定位：

| 桩的挂法 | 行 `inject=[]` 时的结果 |
| --- | --- |
| 根上 `app.provide(...)` | **挂载成功**（检查被绕过） |
| 由 root 的**子 fiber**（模拟宿主行）`ctx.provide(...)` | 抛 `cannot get property ... without inject` ✅ |
| 同上 + 再包一层子树 | 同上 ✅ |
| 由 `Service` 子类发布 | 同上 ✅ |

差别在 Cordis 的依赖检查走 **fiber 的 store**：挂在根上的值沿树可见，绕过了 `inject`；而生产里
`systemPrompt` / `tools` 都由宿主行发布、preset 行是**另一棵子树**——正是后三种形状。

**两次踩坑是同一条教训的两次显形**：守卫只要在任何一处"替被测对象承担了责任"
（补声明、补 loader 语义、把桩挂到无需求的位置），它就会安静地变成假保证。
所以每个守卫都必须做"故意弄坏 → 必须变红 → 还原 → 变绿"，而且**变异点要覆盖每一种承责方式**。

#### 与既有结论的关系

- E19（一行坏掉拖垮整份挂载）在这里**第二次被证实**，且这次触发它的不是运行时错误而是**声明缺失**；
- 这条属于"**接口契约类**"缺陷：类型系统看不见（`ctx.systemPrompt` 的类型来自 dsh 的类型扩展，
  没有 inject 也照样通过 `tsc`），静态结构检查也看不见（`check-preset.mjs` 全绿），
  只有装载期或专门守卫能看见；
- 因此它被并入标准验证清单：`typecheck` → `test` → `check-preset.mjs` → **`probe-preset-rows.mjs`** →
  `check-tool-catalog.mjs` → smoke / spike。
- 附带的方法论：**报错文本一字不变时，先怀疑"改动没到达生效位置"，而不是"这个方向不对"**。
  本次两层根因的报错完全相同，区分它们的唯一办法是逐层验证（探针给出的 `inject=[]`
  与生产的完整错误文本对上了，才算定位）。

---

### 12.10 真实会话首轮联调：三个缺陷与同一条根因（2026-09-17，E31 / E32）

preset 挂载修好之后，用户按 §12.4 的链路跑第一个真实会话（课题：**跨生成器/跨域泛化的
Deepfake 检测**），第一步 `cvagent_scope_set` 成功，随后 `cvagent_kb_scout` 连续失败。
逐条从 transcript 里核过（`~/.dsh/sessions/.../session.v3.jsonl.zstd`，多帧 zstd，
解压后可完整复盘）：

| # | 现象（原始错误串） | 根因 | 归属 |
| --- | --- | --- | --- |
| E1 | `缺少检索范围：请先 cvagent_scope_set 落盘…`，但 `scope_ready: true` | Scout 只认入参，从未读项目状态（而工具描述一直承诺会读） | 本插件（E32-②） |
| E2 | `Cannot read properties of undefined (reading 'aborted')`，3 次 | 委派请求漏传**必填**的 `signal` | 本插件（E31） |
| E3 | 两条 `read` 的 `tool call aborted before dispatch` | **不是缺陷**：`dsh-session-checkpoint-policy` 在分发前看到 `exec.signal` 已中止就拒绝。该批读取发生在 Scout 失败之后很久，且紧接着 `ask_user_question` 被"用户取消"——是用户中止了回合 | 非缺陷 |

#### 同一条根因：我们替对方写了它的契约

这三个（加上 E30）看着毫不相干，根因是同一个动作：

| 事故 | 我们"替对方写"的东西 | 于是没有被检查的东西 |
| --- | --- | --- |
| E30 | 测试自己写了一份 `inject: ['systemPrompt']` | 行模块**自己**的声明够不够 |
| E30 第二层 | 以为"写了命名 `inject`"就等于"loader 读得到" | loader 的 `unwrapExports` 解包规则 |
| E31 | 四个文件各抄 `SubagentLike { request: unknown }` | 委派请求的**每一个字段**（含必填 `signal`） |
| E32-① | 白名单与 prompt 各写一份、无人对账 | 两者是否互相成立 |

**判据**：只要一个事实同时出现在两处（声明与实现、prompt 与白名单、镜像与真类型），
就必须有**一处是权威、另一处由机器对账**。本仓库现在的对账点：

- 真类型 → `src/subagent.ts` 镜像：`tests/subagent-contract.test.ts`（读已安装的 `types.d.ts`）
- 行模块声明 → loader 语义：`tests/row-inject.test.ts` + `scripts/probe-preset-rows.mjs`
- 委派 prompt → toolFilter：`tests/kb-research.test.ts`（prompt 里推荐的每个 `mcp__asta__*` 必须在白名单内）
- 预设结构 → 挂载规则：`scripts/check-preset.mjs`

#### 顺带纠正一个误读：`knowledge_building: pending` ≠ 库是空的

同一次会话里 `cvagent_state_get` 显示 `stages.knowledge_building.status = "pending"`，
而 `cvagent_kb_summary` 显示库里有 390 篇论文 / 171 条四库条目。这两者**不矛盾**：

- `pending` 是**阶段状态**——`cvagent_state_advance` 从未被调用过，门控未结算；
- 四库条数是**语料存量**——此前课题积累的产物，与本次课题无关。

真正的待决问题（用户已提出，需人工定夺）是**存量归属**：390 篇论文与 171 条条目
是上一个课题的语料，而新课题（跨域泛化）要在同一份 `metadata.db` 与同一个项目状态上继续。
判据读的是**绝对总量**，因此"知识建成"的门控会被历史存量直接顶过——门控于是变成形式。
处理方案见 §12.11。

---

### 12.11 存量语料：已裁定沿用 + 记口径基线（方案 C，2026-09-17 用户裁定）

> 起因：`cvagent_state_get` 显示 `knowledge_building: pending` 而库里有 390 篇 / 171 条。
> 两者**不矛盾**（前者是阶段状态，后者是语料存量），但暴露了一个真问题：**判据读绝对总量**，
> 于是新课题一落盘范围，"知识建成"就被上一个课题的存量直接顶过——门控变成形式。

三个方案与裁定：

| 方案 | 结论 |
| --- | --- |
| A. 直接沿用、不设基线 | 否——门控失去判据意义 |
| B. 全新开始、旧库冻结 | 否——已解析 154 篇、21 篇提取、171 条条目都是真工作量，且引用与去重都要用这份语料 |
| **C. 沿用 + 记口径基线** | **采纳**（用户 2026-09-17 选择） |

#### 实现

- `ProjectState` 新增 `scope_baseline`（`core/src/state/machine.ts`）：换课题时记下
  `{papers, parsed, extractions, entries, recorded_at, sub_domain, keywords}` 快照；
- `setResearchScope(state, scope, now, snapshot)` 只在**范围真的变了**时记录基线，
  重复落盘同一范围**不动**它（否则每次 `scope_set` 都把进度清零）；快照惰性求值，
  范围没变就不查库；
- `evaluateCriteria` 的知识阶段：**有基线时判据按"相对基线的新增"算**，无基线（新项目）
  退回绝对口径，行为与加基线之前完全一致；
- 缺失项文案带上两个数：`论文库新增 5/100 篇（存量 395，基线 390）`——**门控在量什么一眼可见**，
  这是"数字要能核对"这条硬规则在门控上的延伸；
- dsh 侧 `ProjectStateService.setScope` 通过 `snapshotCounts()` 从 kb 采集快照（同 realm）。

真实场景下的效果：库里已有 390 篇 → 落盘新范围 → `advance` 报
`论文库新增 0/100 篇（存量 390，基线 390）`，**不再直接放行**；等 Scout 真的补进新论文
（且经解析、提取、归纳）后才会达标。

**顺序语义（值得记住）**：基线记在"范围落盘那一刻"。所以正确的工作流是
**先 `cvagent_scope_set`，再建语料**；反过来（先有语料后落范围）会让基线等于语料本身，
门控要求新增——这是刻意的，也是方案 C 的全部意义。

---

## 附录 A：本次已落地的仓库产物

```
D:\Code\VScodeRepo\dsh-plugin\          ← cv-research-agent monorepo 根
├── package.json                        pnpm workspace 根，packageManager 锁定 12.4.2
├── pnpm-workspace.yaml                 packages/* 与 packages/vendor/*
├── tsconfig.base.json                  严格模式基线（core/dsh-plugin/mcp-server 共用）
├── .npmrc                              pnpm 状态目录内移（绕开 sandbox 限制）
├── .gitignore                          data/ 与密钥排除（§11、§23）
├── packages/
│   ├── core/                           @cv-research/core（纯 TS，零 dsh 依赖）
│   │   ├── src/schema/kb.ts            三库契约（基础字段 + Domain Pack 扩展字段）
│   │   ├── src/scoring/idea.ts         Idea 打分契约 + 授权模型（§4.6）
│   │   ├── src/state/machine.ts        大 Loop 状态机与门控（纯函数）
│   │   ├── src/domain/pack.ts          Domain Pack 契约（冻结需评审签名）
│   │   └── tests/                      17 条测试（门控 8 + 授权 9）
│   ├── dsh-plugin/                     cv-agent-dsh（声明 dsh.bundle.patch）
│   │   ├── src/tools/names.ts          工具名契约（21 个 cvagent + 12 个 vendored 引用）
│   │   └── tests/                      names.test.mjs、role-matrix.test.mjs
│   ├── mcp-server/                     @cv-research/mcp（占位，Phase 1 后实现）
│   └── vendor/dsh-ai4scholar/          上游 0.3.7（MIT），已构建出 lib/
├── tests/
│   ├── smoke-vendor-plugin.mjs         L1 实证：38 工具注册验证
│   └── spike-s1-tool-isolation.mjs     L1 实证：工具白名单隔离（12 条断言）
└── docs/
    └── CV-Research-Agent_勘误与修订设计-v1.3.md   本文件
```

## 附录 B：运行记录

```
pnpm -v                                        → 12.4.2
node -v                                        → v24.19.0
git --version                                  → 2.51.0.windows.1
pnpm install (root)                            → 自动构建 vendored 包
node tests/smoke-vendor-plugin.mjs             → SMOKE OK, toolCount=38
dsh plugin --profile web add link:...          → + dsh-ai4scholar, bundles 追加成功
pnpm run typecheck                             → 4/4 包通过（含 vendored）
pnpm -r --if-present run build                 → 4/4 包通过
pnpm test                                      → 全部通过：
                                                   core        17 passed
                                                   dsh-plugin  16 passed（状态层 10 + 工具管线 6）
                                                   mcp-server  尚无测试（占位阶段，passWithNoTests）
                                                   vendor      88 passed | 2 skipped
node tests/spike-s1-tool-isolation.mjs         → S1 SPIKE OK, 12 条断言
node packages/dsh-plugin/tests/names.test.mjs  → NAMES CONTRACT OK
node packages/dsh-plugin/tests/role-matrix.test.mjs → ROLE MATRIX SPEC OK（5 个角色）
```

**本轮修正的两处工程缺陷**（都是「命令看起来绿、实际有问题」的类型）：

1. `pnpm -r build` 因 `mcp-server` 的空 `src/` 以 TS18003 失败——空目录会掩盖真正的编译错误。已加占位模块。
2. 根 `pnpm test` 因 `mcp-server` 无测试文件而以非零退出（`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`），
   把「还没写测试」伪装成「测试失败」。已加 `passWithNoTests`。

**一处环境记录**：`.npmrc` 把 pnpm 的 global/state/store 指向 `.pnpm-home/`。这最初是为绕开
受限文件策略（pnpm 的 package-manager env 目录不可写），现在作为「pnpm 状态全部留在工作区内」
的工程选择保留——部署到 CI 或云 GPU 机器时可按需删除。

### B.2 Phase 2 验收（P2-7，2026-09-17）

```
node scripts/import-zotero.mjs                 → 147 条入库（151 个 PDF，pdf_path 全部命中）
node scripts/enrich-asta.mjs                   → 145/147 拿到外部 ID（2 条无结果）
node scripts/batch-parse.mjs --dry-run         → 146 篇合格、预算 1900 页（额度门生效）
node scripts/batch-parse.mjs                   → 8 chunk 提交；第 3 块 429 → 退避重试
node scripts/batch-parse.mjs --resume          → 40/40 成功（第一次中断后续跑）
node scripts/batch-parse.mjs                   → 提交剩余 106 篇（含 6s 块间停顿）
node scripts/batch-parse.mjs --resume          → 86/86 成功（local: 路径崩溃修复后续跑）
                                                  合计 146/146，失败 0，额度 1900/2000 页
node scripts/db-stats.mjs                      → papers=390（manual 147 + asta 243）
                                                  parsed=147  failed=0  extractions=21
node scripts/check-md-paths.mjs                → md_path 147/147 存在且 ≥1KB
node scripts/fix-dir-names.mjs                 → 修 3 个「尾随空格目录名」（PowerShell 读不到）
node scripts/asta-control.mjs                  → 4 组关键词：发现 244、富化 244、入库 243、
                                                  待复核 1；外部 ID 244/244；库 147→390
node scripts/pick-spotcheck.mjs --n 20         → 分层抽样 20 篇（arxiv 7 / doi 7 / local 6）
20 × subagent（Reader，spawn）                  → 20 个提取 JSON（独立上下文、只读文件）
node scripts/load-extractions.mjs --audit      → 21/21 契约通过，非法 0，警告 0
node scripts/load-extractions.mjs              → 写库 21 条 paper_extractions
node scripts/export-entries.mjs                → 既有三库 6 条（P001/M001/I001–I004）
node scripts/digest-extractions.mjs            → 21 篇摘要 68KB（Analyst 单文件输入）
subagent（Analyst）                             → p27-analyst-entries.json
node scripts/load-entries.mjs <entries>        → 条目校验 + 装载（三库计数见 §8.4）
pnpm run typecheck                             → 4/4 包通过
pnpm test                                      → core 24 / dsh-plugin 65 / vendor 88|2 全绿
node tests/smoke-vendor-plugin.mjs             → SMOKE OK
node tests/spike-s1-tool-isolation.mjs         → S1 SPIKE OK
node packages/dsh-plugin/tests/names.test.mjs  → NAMES CONTRACT OK
node packages/dsh-plugin/tests/role-matrix.test.mjs → ROLE MATRIX SPEC OK
```

**本轮修正的三处工程缺陷**（同样属于「检查看起来绿、换个入口就崩」）：

1. **单篇路径崩溃拖垮整批**：`local:` 论文 ID 带 `:`，Windows 上 `mkdir` 抛 ENOENT，
   进程直接退出，已提交的 106 篇进度被搁置。已加 `safeDirName()` + 逐篇 `try/catch`（E24）。
2. **尾随空格目录名**：截断正好落在空格上时，Node 读得到而 PowerShell/资源管理器读不到，
   `check-md-paths.mjs` 全绿却打不开目录。已加去尾随空格/点 + `fix-dir-names.mjs` 修复（E24 续）。
3. **提取装载的幂等性**：中断重跑会重复下载与重复记账；已加「已解析则跳过」判断，并在
   `--resume` 路径上先关连接、再删临时目录（Windows 上 sqlite 未关时删目录必 EBUSY）。

