# cv-agent-dsh

以 DeepSeek Harness（dsh）为运行时底座、面向计算机视觉深度学习领域的自主科研 Agent 平台。

覆盖「文献检索 → 知识构建 → Idea 生成与评估 → 实验编排与执行 → 结构化交付 → 论文写作」全流程，
定位是**科研协作管线**，不是论文生成器。

- 本仓库：`cv-agent-dsh`
- dsh 插件：`cv-agent-dsh`（`packages/dsh-plugin`）
- 核心包：`@cv-research/core`（`packages/core`，零 dsh 依赖）
- 首个落地 Domain Pack：Deepfake Detection

## 当前状态

**Phase 2 / 3 与 S5 已交付，四个机制层均已打通并有契约测试**：

| 模块 | 现状 |
| --- | --- |
| **论文库** | 424 篇 / 已解析 154 / 结构化提取 21；四个库 171 条条目；模块清单 69 条（每个模块可回溯到来源论文） |
| **撞车评估** | 子代理读「问题库 + 模块清单」全文挑候选（**不用文本相似度**）→ 证据卡 → 三位专家判模块级对齐 → 分歧一轮讨论 → 中位数聚合 |
| **Idea 打分** | 四维分由专家推理给出（问题/方法/组合新颖度 + 可行性），权重来自冻结的 Domain Pack（`deepfake-detection@0.1`），报告自包含可复算 |
| **实验段** | 按裁定不做编排工具，改为「文件归档原则 + 只读校验脚本」，执行交给 dsh 自身 |

测试：`core 66 / mcp-server 24 / dsh-plugin 232 / vendor 88`；工具目录 21 个，无悬空契约。

> 设计取舍的完整记录（**含被否决的方案与实测数据**）见
> [`docs/论文库与撞车打分整合设计-v1.0.md`](docs/论文库与撞车打分整合设计-v1.0.md)。
> 其中 §9.1 记录了"为什么不上向量检索"：本地 embedding 在真实库上正负例分布重叠、
> 阈值定不出来，排序还不如字面——那一路的代码已删除，但结论留下了。

**动手改代码前请先读** [`docs/CV-Research-Agent_勘误与修订设计-v1.3.md`](docs/CV-Research-Agent_勘误与修订设计-v1.3.md)：
它修正了 v1.2 设计文档中关于子代理隔离、门控机制、服务落位的关键错误，
其中 §4.1 / §4.2 / §4.4 是后续实现的直接依据。

## 工具栈（2026-09-16 调整）

| 能力 | 现方案 | 说明 |
| --- | --- | --- |
| 学术检索 | **Asta MCP**（Ai2，Semantic Scholar 图谱） | 8 个工具，经 dsh 自带的 `dsh-mcp-client` 桥接，名字形态 `mcp__asta__*` |
| 全文获取 | **paper-fetch** skill（插件自带，`packages/dsh-plugin/skills/`） | DOI / 标题 → PDF，七源回退；Sci-Hub 兜底**默认已关**（合规红线 #1） |
| PDF 解析 | MinerU **官方 API**（`mineru.net/api/v4`） | **仅走 API，不做本地部署**（2026-09-16 决定）；服务与工具行尚未落地 |
| ~~学术检索（旧）~~ | ~~dsh-ai4scholar~~ | **已从 web profile 停用**。源码保留在 `packages/vendor/` 备查，不再装载 |

> ⚠️ 随 ai4scholar 停用，**两处能力一并移除**，不是改名：全文/PDF 读取（由
> paper-fetch 补上获取、解析待 MinerU）、以及 `auto_cite` / `sci_draw`
> （写作阶段的引用插入与科研绘图，**目前无替代，缺口未关闭**）。

## 目录结构

```
.dsh/skills/                  第三方 skill 归档（36 个）：CCFA（写作·绘图·投稿）/
                              nature / academic-research —— 由 CV_PROJECT_SKILLS_DIR 钉住
scripts/                      启动脚本（start-dsh-web.ps1）、Asta 预检、skill 根的环境变量
.env.example                  密钥模板（复制为 gitignore 的 .env.local）
packages/
├── core/                     @cv-research/core —— 平台无关核心（schema / scoring / domain / state）
├── dsh-plugin/               cv-agent-dsh —— dsh 适配层（Service / Tool / Preset / Guard）
│   └── skills/               插件自带的 skill（paper-fetch）—— 随包分发，由 CV_PLUGIN_SKILLS_DIR 钉住
├── mcp-server/               @cv-research/mcp —— 核心能力的 MCP 服务化
└── vendor/dsh-ai4scholar/    上游插件源码（MIT）——已停用，仅备查
configs/                      modes.yml / experiment_constraints.yml / budget.yml
domain-packs/                 领域包（deepfake-detection@0.1 等）
docs/                         文档与勘误
tests/                        冒烟与集成测试
data/                         运行期数据（gitignore）
```

> **skill 有两处根，都不在"会话工作区"里**：dsh 默认只扫描会话工作区所属项目根下的
> `.dsh/skills`，换个目录跑科研项目就会**静默找不到任何 skill**。因此 `cv-research`
> preset 的 `skill-filesystem` 行通过 `customSkillDirs` 显式挂载这两处，路径由
> `scripts/start-dsh-web.ps1` 用环境变量钉成绝对路径。启动宿主请用该脚本。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22.19（实测 v24.19.0） | dsh 硬性要求 |
| pnpm | 12.x（实测 12.4.2） | `dsh plugin` 是 pnpm 转发器，**缺 pnpm 会直接失败** |
| dsh | 0.1.5-rc.1 | `npm i -g @deepseek-ai/dsh` |
| 代理 | 任一可出网的本地代理（实测 `127.0.0.1:10808`） | Asta 域名在本网络被 Google 前置层拦截，见约束 6 |

## 快速开始

### 一键启动（推荐）

桌面入口：双击 **「启动 CV-Research」**（开始菜单搜 `cv` 也有一个）。行为：

- 宿主已在运行 → 直接打开浏览器（不会重复起宿主）
- 宿主没运行 → **注入必需的前置**（代理 / 密钥 / skill 根）后启动
- 代理客户端没开 → 提示并等你启动，避免起出一个"没有检索工具"的宿主

首次在新机器/新用户上安装这个入口：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-desktop-shortcut.ps1
# 只装桌面、不装开始菜单：加 -NoStartMenu
```

只想检查环境、不启动宿主：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-dsh-web.ps1 -DryRun
```

> ⚠️ **不要用裸 `dsh web` 启动**。它不会注入下面这些前置，而缺失的后果是**静默的**
> （工具消失、不报错），详见「已知工程约束」里的 E29：
> `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（Asta 的 MCP transport 是 fetch，两者缺一不可）、
> `NO_PROXY`（含 MinerU 的三个国内域名）、`CV_PROJECT_SKILLS_DIR` / `CV_PLUGIN_SKILLS_DIR`
> （skill 根，与工作区解耦）、`ASTA_API_KEY` / `MINERU_TOKEN`（从 `.env.local` 读入）。
>
> 另注：仓库里的 `.ps1` 含中文，**必须带 UTF-8 BOM**——Windows PowerShell 5.1
> 读无 BOM 的脚本会按 GBK 解码、中文变乱码并**在解析期直接报错**（E28）。
> `pnpm test` 里的 `tests/ps1-encoding.test.ts` 会拦住这个回归。

### 开发流程

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

测试分布：`core` 53 条（门控语义 8 + 授权模型 9 + 打分确定性层 19 + 阶段判据 10 + 状态机 7）、
`dsh-plugin` 116 条（状态持久化 / 状态族工具管线 / 三库检索与读写 / Reader·Scout·Analyst 委派 /
idea 生成与打分 / 主编排护栏 / 脚本编码护栏）、`vendor` 上游自带 88 条（2 skipped）。

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
