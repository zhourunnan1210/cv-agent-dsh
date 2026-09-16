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
| 4 | S4 sqlite-vec 压测 | 需要选定 embedding 维度 | Phase 3 前 |
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
| P2-6 | Reader 结构化提取（走 outputSchema 的子代理）与 Analyst 三库更新 | 🔄 进行中：**全链路试点打通**（1 篇 15 页 arXiv 论文）——Zotero PDF → MinerU 解析（31 个产物、额度记账 +15 页）→ Reader 十字段提取（core `PaperExtraction` 契约 + 迁移 v3 `paper_extractions` 表 + `saveExtraction`，papers.extraction_quality 镜像）。待续：Reader 子代理 outputSchema 工具化 + Analyst 三库条目生成 + 批量解析 | 我 |
| P2-7 | Phase 2 验收：从 0 检索某 Deepfake 子主题 → ≥100 篇论文库与三库，抽检 20 篇 | P2-5/6 | 我 |

> P2-0 是 Phase 2 的**启动闸门**（v1.2 §14 的截止项）。P2-1/2/3 是外部事实，
> 不阻塞 schema 冻结，但阻塞 P2-4/5 的实现。

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
