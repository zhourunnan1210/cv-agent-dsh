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
pnpm install          # 同时会触发 vendored dsh-ai4scholar 的 prepare 构建
node tests/smoke-vendor-plugin.mjs   # 验证基座插件 38 个工具注册正常
```

## 已知工程约束

1. **`dsh plugin add` 会写 `$DSH_HOME/profiles/<name>/node_modules`**，在工作区之外；在受限文件策略下需要提权审批。
2. **pnpm 全局安装与自身状态目录**可能被文件策略拒绝；本仓库的 `.npmrc` 已把 pnpm 状态目录移入工作区内。
3. **新增 bundle 行不会热加载**：`dsh.profile.bundles` 的改动需要重启 dsh 宿主进程才生效。
4. **vendored 上游包必须构建**：上游源码仓库不含 `lib/`，克隆后需 `pnpm install`（触发 `prepare`）或 `pnpm run build`。

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/CV-Research-Agent_勘误与修订设计-v1.3.md` | **先读这个**：对 v1.2 的勘误、修订版设计、Phase 0 结论 |
| `NOTICE.md` | 第三方许可与学术合规红线 |

## 许可

MIT，见 [`LICENSE`](LICENSE)。第三方组件见 [`NOTICE.md`](NOTICE.md)。
