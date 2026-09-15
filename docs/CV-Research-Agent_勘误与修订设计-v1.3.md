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

---

## 5. Phase 0 Spike 修订与状态

### 5.1 S1 —— dsh 多 Preset 工具隔离

- **v1.2 的提法**：写 demo 验证两个 preset 各挂不同工具互不可见。
- **结论（L2）**：提法本身是错的问题。子代理不通过 preset 隔离（E1）。**已用运行时契约替代该 Spike**，设计改为 §4.1。
- **替代验收项**：写 demo 验证「父会话工具面全量」+「委派时 `toolFilter.deny` 生效」——即子代理看不到被 deny 的工具。**待主机重启后实跑**。

### 5.2 S2 —— 子代理上下文隔离

- **结论（L2）**：`spawn` provider 不继承父会话历史（区别于 `fork`）；父 Agent 只拿到 `SubagentResult{ output, structured, diagnostic, stopReason }`。这正是 §1.3 原则四要的语义。
- **替代验收项**：派发一个长任务，验证 ① 子代理不携带父历史；② 父只收到 `structured`；③ `outputSchema` 违反时报错而非静默回传自由文本。**待实跑**。

### 5.3 S6 —— gate / 审批机制承载 ABC 模式

- **结论（L2 + L3）**：dsh **没有**可直接承载 §4 三模式的通用 gate 服务。可行路径是 §4.3 的三段式（状态落盘 + `ask_user_question` + 决议落盘）。
- **已知限制（L2）**：`ask_user_question` 在 plan mode 生效期间被禁用；若部署没有可用的 answerer，审批类请求会 fail-closed。A 模式在无人在场的环境下会卡住——这恰好说明 **A 模式不该用于无人值守**，与 §4.1 表格一致。

### 5.4 仍未验证（需主机重启或外部资源）

| # | 项目 | 为什么现在做不了 | 建议时机 |
| --- | --- | --- | --- |
| 1 | 新增 bundle 行在真实会话中生效 | 需要重启 dsh 宿主进程；该进程正在承载本次对话 | 你方便时重启，然后开一个新会话验证工具清单 |
| 2 | S3 MinerU 本地吞吐 | 需要 4090 机器 + MinerU 部署 | 与 dsh 侧并行，不阻塞 |
| 3 | S4 sqlite-vec 压测 | 需要选定 embedding 维度 | Phase 3 前 |
| 4 | S5 MCP 封装 | 依赖 core 层有可封装的接口 | Phase 1 后 |
| 5 | ai4scholar.net 真实调用与计费标定 | 需要 API key 与额度 | Phase 2 前（影响 §20 成本模型） |

> ⚠️ 关于重启：我**没有**重启 dsh 宿主，因为那个进程正在承载本次对话，重启会终止本会话。新增的 `dsh-ai4scholar` bundle 行已写入 profile 层栈，但当前进程不会加载它。请你在方便时重启，并开新会话确认 38 个工具出现。

---

## 6. 对 §12 路线图的修订建议

v1.2 的 Phase 划分基本合理，但有三处需要调整：

1. **Phase 0 的 S1/S2/S6 描述改写**（§5），并明确"S1 的结论是改设计而非改实现"。
2. **Phase 1 增加一项独立任务：服务平面归属判定**（§4.4 末尾）。这是"改起来代价很大"的决定，必须在写任何 Service 之前完成，不宜并入"注册骨架"。
3. **Phase 2 增加前置：ai4scholar 真实调用与计费标定**（§20 成本模型的输入）。否则 C 模式预算护栏（§4.2）没有可用参数。

---

## 7. 下一步（按依赖排序）

| 顺序 | 事项 | 依赖 | 谁能做 |
| --- | --- | --- | --- |
| 1 | 评审并冻结本文件的 §4.1 / §4.2 / §4.4 | — | 你 |
| 2 | 服务平面归属判定：`kb` / `ideaScore` / `expOrchestrator` / `projectState` 各自归宿主还是 preset | §4.4 | 你 + 我 |
| 3 | 写 `cv-agent-dsh` 的第一批 row + 一个 `cvagent.state.get` 工具，链入 profile | 2 | 我 |
| 4 | 重启 dsh 宿主，新会话验证：38 个 ai4scholar 工具 + `cvagent.*` 工具同时出现 | 3 | 你重启，我验证 |
| 5 | 实跑 S1/S2/S6 替代验收项 | 4 | 我 |
| 6 | 冻结三库 schema（v1.2 §14 的待决策项，也是 Phase 2 的截止点） | 1 | 你 |

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
│   ├── dsh-plugin/                     cv-agent-dsh（声明 dsh.bundle.patch）
│   ├── mcp-server/                     @cv-research/mcp
│   └── vendor/dsh-ai4scholar/          上游 0.3.7（MIT），已构建出 lib/
├── tests/
│   └── smoke-vendor-plugin.mjs         L1 实证脚本：38 工具注册验证
└── docs/
    └── CV-Research-Agent_勘误与修订设计-v1.3.md   本文件
```

## 附录 B：运行记录

```
pnpm -v                                        → 12.4.2
node -v                                        → v24.19.0
git --version                                  → 2.51.0.windows.1
pnpm install (root)                            → Done in 20s, 自动构建 vendored 包
node tests/smoke-vendor-plugin.mjs             → SMOKE OK, toolCount=38
dsh plugin --profile web add link:...          → + dsh-ai4scholar, bundles 追加成功
```
