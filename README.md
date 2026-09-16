# cv-research-agent

以 DeepSeek Harness（dsh）为运行时底座、面向计算机视觉深度学习领域的自主科研 Agent 平台。

覆盖「文献检索 → 知识构建 → Idea 生成与评估 → 实验编排与执行 → 结构化交付 → 论文写作」全流程，
定位是**科研协作管线**，不是论文生成器。

- 总仓库（本仓库）：`cv-research-agent`
- dsh 插件：`cv-agent-dsh`（`packages/dsh-plugin`）
- 核心包：`@cv-research/core`（`packages/core`，零 dsh 依赖）
- 首个落地 Domain Pack：Deepfake Detection

## 当前状态

**Phase 0 完成 / Phase 1 收口阶段。** 已产出可运行的第一批能力：`projectState`
服务 + 状态族 5 工具 + 主编排执行级护栏，以及可挂载的 `cv-research` agent preset。

**动手改代码前请先读** [`docs/CV-Research-Agent_勘误与修订设计-v1.3.md`](docs/CV-Research-Agent_勘误与修订设计-v1.3.md)：
它修正了 v1.2 设计文档中关于子代理隔离、门控机制、服务落位的关键错误，
其中 §4.1 / §4.2 / §4.4 是后续实现的直接依据。

## 工具栈（2026-09-16 调整）

| 能力 | 现方案 | 说明 |
| --- | --- | --- |
| 学术检索 | **Asta MCP**（Ai2，Semantic Scholar 图谱） | 8 个工具，经 dsh 自带的 `dsh-mcp-client` 桥接，名字形态 `mcp__asta__*` |
| 全文获取 | **paper-fetch** skill（`.dsh/skills/`） | DOI / 标题 → PDF，七源回退；Sci-Hub 兜底**默认已关**（合规红线 #1） |
| PDF 解析 | MinerU **官方 API**（`mineru.net/api/v4`） | **仅走 API，不做本地部署**（2026-09-16 决定）；服务与工具行尚未落地 |
| ~~学术检索（旧）~~ | ~~dsh-ai4scholar~~ | **已从 web profile 停用**。源码保留在 `packages/vendor/` 备查，不再装载 |

> ⚠️ 随 ai4scholar 停用，**两处能力一并移除**，不是改名：全文/PDF 读取（由
> paper-fetch 补上获取、解析待 MinerU）、以及 `auto_cite` / `sci_draw`
> （写作阶段的引用插入与科研绘图，**目前无替代，缺口未关闭**）。

## 目录结构

```
.dsh/skills/                  项目级 skill 根（dsh 自动发现）：37 个 skill —— paper-fetch /
                              CCFA（写作·绘图·投稿）/ nature / academic-research
scripts/                      启动脚本（start-dsh-web.ps1）与前置自检
.env.example                  密钥模板（复制为 gitignore 的 .env.local）
packages/
├── core/                     @cv-research/core —— 平台无关核心（schema / scoring / domain / state）
├── dsh-plugin/               cv-agent-dsh —— dsh 适配层（Service / Tool / Preset / Guard）
├── mcp-server/               @cv-research/mcp —— 核心能力的 MCP 服务化
└── vendor/dsh-ai4scholar/    上游插件源码（MIT）——已停用，仅备查
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
| 代理 | 任一可出网的本地代理（实测 `127.0.0.1:10808`） | Asta 域名在本网络被 Google 前置层拦截，见约束 6 |

## 快速开始

```bash
pnpm install                          # 构建 vendored dsh-ai4scholar + core + dsh-plugin
pnpm typecheck                        # 全 workspace 类型检查
pnpm -r --if-present run build        # 全 workspace 构建
pnpm test                             # 全 workspace 测试
```

L1 实证脚本（驱动真实 dsh 运行时，非 mock）：

```bash
node tests/spike-s1-tool-isolation.mjs                # 工具白名单隔离（12 条断言）
node packages/dsh-plugin/tests/names.test.mjs         # 工具名契约（离线，真实 ToolRuntime）
node packages/dsh-plugin/tests/role-matrix.test.mjs   # §16.1 角色矩阵规格（5 个角色）
node tests/smoke-vendor-plugin.mjs                    # 已停用的上游插件仍能注册 38 个工具（备查）

# Asta MCP 线上对齐：需要网络 + 代理 + key（见"已知工程约束"6）
# PowerShell:
$env:ASTA_API_KEY='<key>'; $env:HTTPS_PROXY='http://127.0.0.1:10808'; $env:NODE_USE_ENV_PROXY='1'
node tests/spike-asta-mcp.mjs                         # 装载 → 注册 → 真实执行 → 卸载（5 条断言）
```

测试分布：`core` 17 条（门控语义 8 + 授权模型 9）、`dsh-plugin` 27 条（状态持久化 10 +
状态族工具管线 11 + 主编排护栏 6）、`vendor` 上游自带 88 条（2 skipped）。

> `lib/` 构建产物不入库，由 `pnpm install` 的 `prepare` 脚本现场生成；
> 若 `node_modules` 已存在而 `lib/` 缺失，手动执行 `pnpm -r run build`。

## 已知工程约束

1. **新增 bundle 行与 preset 改动都不会热加载**：`dsh.profile.bundles` 或 preset
   组合文件的改动需要重启 dsh 宿主进程才生效。运行中的宿主会缓存 ①已加载的插件
   模块、②包根 `package.json` 的 exports 解析，二者都不随文件 mtime 失效
   （E21，三轮 mount-validate 实证）。
2. **vendored 上游包必须构建**：上游源码仓库不含 `lib/`，克隆后需 `pnpm install`（触发 `prepare`）或 `pnpm run build`。
3. **`dsh plugin add` 会写 `$DSH_HOME/profiles/<name>/node_modules`**（工作区之外），并需要 `pnpm` 在 PATH 上——`dsh plugin` 是 pnpm 转发器，缺 pnpm 会返回 127。
4. **本仓库的 `.npmrc` 把 pnpm 的 global/state/store 目录指向 `.pnpm-home/`**：这样 pnpm 的全部状态都留在工作区内，部署到 CI 或云 GPU 机器时可按需删除这几行。
5. **测试用 worker_threads 池**：`vitest.config.ts` 里 `pool: 'threads'` 是为了绕开 Windows 上子进程池的 `spawn EPERM`；去掉它会在部分受限环境下失败。
6. **学术检索依赖代理与两个环境变量（缺一即无检索能力）**：Asta 走
   `https://asta-tools.allen.ai/mcp/v1`，该域名与 `allenai.org` 在本网络环境下
   被 Google 前置层统一 403（`google.com` 直接不可达，而 `api.semanticscholar.org`
   正常）。宿主进程必须**同时**设：
   - `HTTPS_PROXY=http://127.0.0.1:10808`（或你的代理地址）；
   - `NODE_USE_ENV_PROXY=1` —— Node 24 的 global fetch 缺这个 flag 会**直接忽略**
     `HTTPS_PROXY`，而 MCP transport 正是 fetch。实测：只有代理 = 403，代理 + flag = 200；
   - `ASTA_API_KEY`（组合文件里只写 `!!js process.env.ASTA_API_KEY`，字面值不入库）。

   三者任一缺失时 `mcp-asta` 行连不上：agent 会**没有检索工具**，日志有错，但
   preset 仍会正常挂载（`failOnStartupError` 刻意保持默认 false，网络故障不该让
   整个 Orchestrator 会话起不来）。

   **别靠记忆设这三个变量——用启动脚本：**

   ```powershell
   .\scripts\start-dsh-web.ps1            # 设置代理变量 + 从 .env.local 读密钥 + 前置自检 + 启动
   .\scripts\start-dsh-web.ps1 -DryRun    # 只自检不启动：代理是否在监听 / key 是否存在 / 端口是否被占
   ```

   密钥放在 `.env.local`（已被 `.gitignore` 的 `.env.*` 排除，**永不入库**），
   模板见 `.env.example`；已存在于环境中的同名变量优先，不会被覆盖。

7. **profile 的 `bundles` 会被按 `dependencies` 重新对齐**：只从 `dsh.profile.bundles`
   里删掉某个包、却在 `dependencies` 里留着它，下一次插件同步/自升级会把它**加回来**
   （2026-09-16 实测：停用 `dsh-ai4scholar` 后它在一次宿主重启时复活）。要真正停用一个
   bundle，**两处都要删**。

> 约束 1–6 是**工程事实**，与文件策略无关。
> 受限文件策略下另外两件事会失败，均已在实测中确认：`pnpm test` 里 Vitest 加载
> 配置时会用管道 stdio 调子进程（`spawn EPERM`），以及沙箱会拦下工作区之外的写入
> （改 `$DSH_HOME` 下的 profile / preset 需要更宽权限）。

## 文档

| 文件 | 内容 |
| --- | --- |
| `docs/CV-Research-Agent_勘误与修订设计-v1.3.md` | **先读这个**：对 v1.2 的勘误、修订版设计、Phase 0 结论、运行时坑（E16–E22） |
| `docs/mineru-api.md` | MinerU API 接入参考：端点（实测）、限流与额度（官方）、境外 URL 陷阱、与 paper-fetch 的接法 |
| `NOTICE.md` | 第三方许可、外部数据服务、学术合规红线 |
| `.dsh/skills/README.md` | 归档的本地 skill 及其**对上游的修改登记** |
| `packages/dsh-plugin/presets/README.md` | cv-research preset 的权威源说明与依赖 |

## 许可

MIT，见 [`LICENSE`](LICENSE)。第三方组件见 [`NOTICE.md`](NOTICE.md)。
