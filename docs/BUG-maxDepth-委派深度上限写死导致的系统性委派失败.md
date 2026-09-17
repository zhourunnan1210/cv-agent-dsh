# BUG 记录：委派深度上限写死，导致 cv-research 全链路子代理委派失败

- 日期：2026-09-17
- 发现场景：新课题立项（持续学习深度伪造检测），调用 `cvagent_kb_scout` 做文献检索
- 严重级别：**阻断级**（影响 6 个委派型工具，不是单点故障）
- 当前状态：**已修复**（2026-09-17 晚；用户指示"开始修吧"后按方案 A' 实施，见 §6.5）
- 数据影响：无。失败发生在委派阶段，无任何文献被写入

---

## 1. 复现场景

课题立项流程走到"派检索子代理找近两年文献"这一步：

1. `cvagent_scope_set` 落盘研究方向 + 8 个关键词 —— **成功**
2. `cvagent_kb_scout`（关键词组 + 限定 2024 年至今）—— **失败**，报错见下

关键条件：调用方是**根会话的编排 Agent**（无上级、无委派祖先）。这是 GUI 直接开工的正常形态，不是特殊用法。

---

## 2. 报错原文

```
Error: subagent depth 1 exceeds maxDepth 0
```

人话：**子代理至少是第 1 层，但系统只允许到第 0 层，于是任何子代理都派不出去。**

---

## 3. 定位过程（证据链）

逐层往下读代码，得到一条闭合的因果链：

### 3.1 SDK 侧：判据是**子代理的绝对层级**

`@deepseek-ai/dsh-subagent/lib/index.js:432-437`

```js
function resolveChildDepth(parent, maxDepth) {
    const childDepth = delegationDepthOf(parent) + 1;
    if (!Number.isSafeInteger(childDepth)) throw new RangeError(...);
    if (maxDepth !== void 0 && childDepth > maxDepth) throw new SubagentDepthError(childDepth, maxDepth);
    return childDepth;
}
```

- `maxDepth` 是**子代理绝对层级的上限**（`lib/index.js:427` 的原话：`optional absolute cap the resolved depth must not exceed`）
- `childDepth = 父层级 + 1`（`lib/index.js:433`）
- 根会话父层级 = 0 ⇒ 子代理层级 = 1

`SubagentDepthError` 的拼装位置：`lib/index.js:416`，即本次报错的字面来源。

### 3.2 插件侧：把这个参数理解成了另一件事

`packages/dsh-plugin/src/subagent.ts:70-71`

```ts
/** 委派深度上限；0 表示子代理不能再委派。 */
readonly maxDepth?: number
```

插件的注释语义 = **"子代理还能不能再往下派"**（相对语义 / 孙子层面）。

SDK 的语义 = **"子代理自己的绝对层级上限"**。

**同一个字段，两边差一层。** 写 `0` 在插件作者的预期里 = "Scout 不许再派孩子"；在 SDK 的解释里 = "子代理层级必须 ≤ 0"，而子代理不可能是 0 层，于是直接拒绝。

### 3.3 调用侧：确实写死了 0

`packages/dsh-plugin/src/kb/research-tools.ts:272-281`（Scout）

```ts
const run = await subagents.start('spawn', {
  signal: exec.signal,
  parent: exec.agent,
  label: `scout:...`,
  prompt: [{ type: 'text', text: prompt }],
  toolFilter: SCOUT_FILTER,
  persona: SCOUT_PERSONA,
  outputSchema: scoutOutputSchema(),
  maxDepth: 0,          // ← 写死
})
```

### 3.4 因果链小结

```
插件写 maxDepth: 0
      ↓  （SDK 读作"子代理绝对层级上限 ≤ 0"）
根会话层级 0  →  子代理层级 = 0 + 1 = 1
      ↓
1 > 0  ⇒  SubagentDepthError("subagent depth 1 exceeds maxDepth 0")
```

### 3.5 对照：官方默认值本可以正常工作

`@deepseek-ai/dsh-tool-subagent/lib/index.js:269`

```js
maxDepth: z.union([z.natural()..., z.const("provider-managed")]).default(3)
```

官方 `subagent` 工具的默认上限是 **3**，根会话派子代理（层级 1 ≤ 3）**完全正常**。失败是插件传参造成的，不是环境不允许委派。

---

## 4. 根因分析

### 4.1 直接根因

**参数语义在适配层被误解**：`maxDepth` 被当作"相对递归预算"，实际是"绝对层级上限"。写死 `0` 使该上限低于任何可行值，导致委派必然失败。

### 4.2 为什么原来没暴露（更值得记的部分）

三条线索说明这是历史遗留、非新引入：

1. **设计文档早已这样记录**：`docs/CV-Research-Agent_勘误与修订设计-v1.3.md:737`、`:1112` 明确写着各工具的委派契约是 `maxDepth: 0`，且描述为"子代理不能再委派"。设计与实现一致，只是**设计本身对字段语义的理解偏了一层**。
2. **测试只验证了"传了什么"，没验证"能不能用"**：`tests/kb-research.test.ts:150`、`tests/idea-tools.test.ts:186`、`tests/writing-tools.test.ts:152`、`tests/kb-extract.test.ts:147` 都是 `expect(call.request.maxDepth).toBe(0)` —— 把错误取值**固化成了期望值**。单测全绿，但断言的是实现，不是行为。
3. **此前这些工具多半在"非根会话"里被跑过**：只要父会话层级 ≥ 1，`父层级+1 ≥ 2 > 0` 依然会失败——**换句话说，这个组合在历史执行里应该也从未成功过**（`subagent.ts` 文件头记录的"`cvagent_kb_scout` 连续失败 3 次"是另一处历史事故：漏传必填 `signal`，见 §4.3）。本次首次从根会话触发，条件最干净，暴露得最彻底。

### 4.3 与上一次事故的共性（事故 E31 的模式）

`packages/dsh-plugin/src/subagent.ts:1-39` 记录了上一次事故：四个工具文件各自抄了一份 `request: unknown` 的接口，导致必填的 `signal` 被漏掉，`tsc` 全绿但真宿主里 `cvagent_kb_scout` 连续失败 3 次。

**同一个模式再次出现**：

| | E31（上次） | 本次 |
|---|---|---|
| 契约字段 | `signal`（必填） | `maxDepth`（语义） |
| 做法 | 本地镜像类型写成 `unknown` | 本地注释写错了语义 |
| 测试 | 类型检查全绿 | 断言写死为 `toBe(0)` |
| 后果 | 运行时报 `reading 'aborted'` | 运行时报 `depth 1 exceeds maxDepth 0` |

结论：**"本地契约镜像 + 单测锁实现"这个组合，是这套代码重复踩坑的地方**；字段值对了，语义仍可能错。

---

## 5. 影响范围（已全仓扫描）

写死 `maxDepth: 0` 的**全部 6 处**（`grep` 结果，`packages/dsh-plugin/src/**/*.ts`）：

| 文件 | 行 | 工具 / 角色 | 影响 |
|---|---|---|---|
| `src/kb/research-tools.ts` | 280 | `cvagent_kb_scout` | 文献检索不可用 |
| `src/kb/research-tools.ts` | 510 | `cvagent_kb_analyze` | 三库归纳不可用 |
| `src/kb/extract-tool.ts` | 160 | `cvagent_kb_extract` | 论文结构化提取不可用 |
| `src/scoring/tools.ts` | 266 | idea 打分（裁判） | 打分不可用 |
| `src/scoring/tools.ts` | 419 | idea 生成（Generator 视角） | 生成不可用 |
| `src/writing/tools.ts` | 299 | `cvagent_write_draft` | 写作不可用 |

**判定**：cv-research 的整条"委派子代理"链路阻断，非单点故障。同时注意 `cvagent_idea_generate` 是**并发 N 个视角**，每一个都会撞同一堵墙。

不受影响的工具：`cvagent_state_*`、`cvagent_scope_set`、`cvagent_mode_set`、`cvagent_kb_summary`、`cvagent_kb_search`、`cvagent_kb_import_paper(s)`、`cvagent_kb_upsert_entry`、`cvagent_gate_resolve` —— 即**所有不派子代理的工具照常可用**（本次 `cvagent_scope_set` 成功即为佐证）。

---

## 6. 修复方案（两种，**尚未实施**）

### 方案 A：显式给出合理上限（推荐）

把 6 处 `maxDepth: 0` 改为 `maxDepth: 3`，语义变为"子代理层级 ≤ 3"，与官方默认一致。

- 优点：保留插件"限制递归"的本意（子代理仍可再派孩子，但受控）；与 SDK 语义对齐
- 风险：低。子代理的 `toolFilter` 本就把工具面限制成 `{cvagent_kb_search, cvagent_kb_summary}` 之类的只读集合，实际不会再派孩子

### 方案 B：不传该字段

删掉 6 处 `maxDepth` 行，改用 SDK 默认 3。

- 优点：少一个可能被误读的字段
- 风险：与"插件显式声明委派契约"的现有风格不一致；若将来 SDK 默认值变化，行为随之变化

### 无论选哪种，必须一并处理

1. **修正 `src/subagent.ts:70-71` 的注释语义**，把"0 表示子代理不能再委派"改成 SDK 的绝对层级口径，并写明"根会话下必须 ≥ 1"。这是本次的真正病根。
2. **修正 4 个测试里的 `toBe(0)` 断言**，否则测试会继续把 `0` 锁死；建议断言改成"取值乐观可派"（如 `toBeGreaterThanOrEqual(1)`）或直接断言"该字段非 0"。
3. **加一条回归测试**：以"父层级 0"为前提校验委派请求可通过深度判据（需要 mock `delegationDepthOf(parent) === 0` 的场景）。

### 生效条件（重要）

插件是**构建产物**，正被 Web GUI 加载。改完源码需：

```
pnpm build        # 或 pnpm -r --if-present build
```

然后**重启 GUI / 新开会话**才生效。当前会话无法就地生效——这也是本次没有直接改代码见效的原因。

### 待确认的一点

GUI 加载的是构建产物；本次修改点是 `packages/dsh-plugin/src` 下的源码，因此"改源码 → 重新构建 → 重启"是必要且充分的。若宿主实际加载的是别处的已安装副本（如预设的工作副本 `presets/cv-research/agent.cordis.yml` 之外还有分发副本），需在构建后核对一次加载路径，避免"改了没生效"。**这一点建议修复时顺带核实。**

---

## 7. 验证步骤（修复后）

1. 跑 `pnpm -r --if-present test`：4 个委派工具测试应改为新断言并通过
2. 跑 `pnpm build`
3. 重启 GUI 后，在**根会话**直接调用 `cvagent_kb_scout`，期望返回候选列表而非 `SubagentDepthError`
4. 顺带验一个**多视角**工具（`cvagent_idea_generate`），确认并发委派不受影响
5. 抽查 `cvagent_kb_extract`（Reader 单子代理）也通

---

## 8. 本次事故的"不该重复"清单

1. **适配层的参数语义，必须对着 SDK 源码确认一次**，不能只看字段名——`maxDepth` 就是活例子
2. **测试断言不能锁死实现取值**：`toBe(0)` 这类断言让错误固化了整个开发周期
3. **委派型工具需要"根会话"这一用例**：所有测试都假设有上级，就没有用例覆盖"顶格调用"
4. **子系统级阻断要单独扫一遍**：本次若不是全仓 `grep`，很容易只修 Scout 一处，剩下 5 处继续埋着

---

## 6.5 实际修复（2026-09-17，方案 A'）

分析稿给的方案 A 是"6 处改成 `3`"。实施时做了一处改进：**不散落字面量，收成一个常量**。

| 项 | 结论 |
| --- | --- |
| 取值 | `SUBAGENT_MAX_DEPTH = 3`，与部署自带 `subagent` 工具的 `default(3)` 一致 |
| 为什么不取 `1` | `1` 只够"根会话派一层"。一旦编排 Agent 自己也是子代理（层级 1），它派出的 worker 是第 2 层，会被**自己设的上限**挡死——同一个 bug 换个场景复发 |
| 为什么不删掉该字段（方案 B） | SDK 的 `default(3)` 在**工具**的 config schema 里；服务层不传就是 `undefined` = **不设上限**。删掉等于放松，与"显式声明委派契约"的现有风格也相反 |
| 落点 | `src/subagent.ts` 导出常量；6 个调用点全部引用它；字段注释改成真语义并附事故原文 |

**补充说明**：真正保证"worker 不再往下派"的不是这个数字，而是每个角色的 `toolFilter`
——子代理的工具面里根本没有 `subagent` 工具。深度上限是第二道保险，不该做成第一道；
把保险值压到临界点（0 或 1）只会让它先杀死正常流程。

### 守卫（两条，都验证过"能失败"）

1. `tests/subagent-depth.test.ts`：**导入已安装的真 SDK**，构造满足 `delegationDepthOf`
   读取方式的假 parent（`agent.options.subagentDepth` / `agent.session.header.delegationDepth`），
   调**真的** `resolveChildDepth(parent, maxDepth)`：
   - 根会话 / 层级 1 / 层级 2 三种前提下都必须能派出；
   - 反向断言 `0` 在任何层级都抛、`1` 在层级 ≥1 的编排者下也抛。
   - **变异验证**：把常量改回 `0` → 报错 `subagent depth 1 exceeds maxDepth 0`，
     抛出点正是 `dsh-subagent/lib/index.js:435`（与生产逐字相同）。
   - 注意这里**不抄判据**：本 session 已经有两次"守卫替被测对象承责，于是永远不会红"的教训
     （E30 的探针、E31 的探针）。
2. `tests/subagent-contract.test.ts` 新增静态扫描：**全部**调用点的 `maxDepth` 不许是字面量 `0`
   （覆盖没有请求形状断言的那 2 处工具）。

### 原报告"待确认的一点"：已核实

宿主加载的是 `C:\Users\Admin\.dsh\profiles\web\node_modules\cv-agent-dsh`，
它是**指向 `packages/dsh-plugin` 的 Junction**（`LinkType: Junction`）。因此
"改源码 → `pnpm -C packages/dsh-plugin run build` → 重启宿主"这一步是**必要且充分**的，
不存在"改了没生效"的分发副本问题。构建后已核对：`lib/subagent.js` 里常量是 `3`，
6 个调用点引用常量，宿主侧同一文件内容一致。
