# cv-research-agent

以 DeepSeek Harness（dsh）为运行时底座、面向计算机视觉深度学习领域的自主科研 Agent 平台。

覆盖「文献检索 → 知识构建 → Idea 生成与评估 → 实验编排与执行 → 结构化交付 → 论文写作」全流程，
定位是**科研协作管线**，不是论文生成器。

- 总仓库（本仓库）：`cv-research-agent`
- dsh 插件：`cv-agent-dsh`（`packages/dsh-plugin`）
- 核心包：`@cv-research/core`（`packages/core`，零 dsh 依赖）
- 首个落地 Domain Pack：Deepfake Detection

## 当前状态

**Phase 0 / Phase 1 起步阶段。** 尚未产出可运行的 Agent 能力；当前仓库包含工程骨架、
已构建的基座插件与 Phase 0 的 dsh 侧验证结论。

**动手改代码前请先读** [`docs/CV-Research-Agent_勘误与修订设计-v1.3.md`](docs/CV-Research-Agent_勘误与修订设计-v1.3.md)：
它修正了 v1.2 设计文档中关于子代理隔离、门控机制、服务落位的关键错误，
其中 §4.1 / §4.2 / §4.4 是后续实现的直接依据。

## 目录结构

```
packages/
├── core/                     @cv-research/core —— 平台无关核心（schema / scoring / domain / state / prompts）
├── dsh-plugin/               cv-agent-dsh —— dsh 适配层（Bundle / Service / Tool / Preset / Event）
├── mcp-server/               @cv-research/mcp —— 核心能力的 MCP 服务化
└── vendor/dsh-ai4scholar/    上游基座插件（MIT，38 个学术工具）
configs/                      modes.yml / experiment_constraints.yml / budget.yml
domain-packs/                 领域包（deepfake-detection@0.1 等）
docs/                         文档与勘误
tests/                        冒烟与集成测试
data/                         运行期数据（gitignore）
```

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.19（实测 v24.19.0） | dsh 硬性要求 |
| pnpm | 12.x（实测 12.4.2） | `dsh plugin` 是 pnpm 转发器，**缺 pnpm 会直接失败** |
| dsh | 0.1.5-rc.1 | `npm i -g @deepseek-ai/dsh` |

## 快速开始

```bash
pnpm install                          # 构建 vendored dsh-ai4scholar + core + dsh-plugin
pnpm typecheck                        # 全 workspace 类型检查
pnpm -r --if-present run build        # 全 workspace 构建
pnpm test                             # 全 workspace 测试（含 vendored 包自带套件）

# L1 实证脚本（驱动真实 dsh 运行时，非 mock）
node tests/smoke-vendor-plugin.mjs             # 基座插件 38 个工具注册
node tests/spike-s1-tool-isolation.mjs         # 工具白名单隔离（12 条断言）
node packages/dsh-plugin/tests/names.test.mjs  # 工具名契约与真实运行时对齐
node packages/dsh-plugin/tests/role-matrix.test.mjs  # §16.1 角色矩阵规格（5 个角色）
```

> `lib/` 构建产物不入库，由 `pnpm install` 的 `prepare` 脚本现场生成；
> 若 `node_modules` 已存在而 `lib/` 缺失，手动执行 `pnpm -r run build`。

## 已知工程约束

1. **新增 bundle 行不会热加载**：`dsh.profile.bundles` 的改动需要重启 dsh 宿主进程才生效。
2. **vendored 上游包必须构建**：上游源码仓库不含 `lib/`，克隆后需 `pnpm install`（触发 `prepare`）或 `pnpm run build`。
3. **`dsh plugin add` 会写 `$DSH_HOME/profiles/<name>/node_modules`**（工作区之外），并需要 `pnpm` 在 PATH 上——`dsh plugin` 是 pnpm 转发器，缺 pnpm 会返回 127。
4. **本仓库的 `.npmrc` 把 pnpm 的 global/state/store 目录指向 `.pnpm-home/`**：这样 pnpm 的全部状态都留在工作区内，部署到 CI 或云 GPU 机器时可按需删除这几行。
5. **测试用 worker_threads 池**：`vitest.config.ts` 里 `pool: 'threads'` 是为了绕开 Windows 上子进程池的 `spawn EPERM`；去掉它会在部分受限环境下失败。

> 上述约束曾在一个受限文件策略的会话中被实测发现并记录（`npm install -g`、`dsh plugin add` 的符号链接、`pnpm test` 的子进程 spawn 都曾被拒）。
> 当前会话的文件策略为 `danger-full-access`，这些操作均可正常执行；约束 1–5 是**工程事实**，与策略无关，保留备查。

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/CV-Research-Agent_勘误与修订设计-v1.3.md` | **先读这个**：对 v1.2 的勘误、修订版设计、Phase 0 结论 |
| `NOTICE.md` | 第三方许可与学术合规红线 |

## 许可

MIT，见 [`LICENSE`](LICENSE)。第三方组件见 [`NOTICE.md`](NOTICE.md)。
