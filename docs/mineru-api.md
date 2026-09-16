# MinerU API 接入参考

> **证据等级**：端点清单与错误码为**本仓库实测**（2026-09-16）；限流、额度、参数取自
> **官方文档原文**（[接口总览](https://mineru.net/doc/docs/) / [限流策略](https://mineru.net/doc/docs/limit/)）。
> 第三方 API 参考（如 Nebutra/MinerU-Skill）在页数上限、批量上限、免费额度三处**与官方不符**，
> 已按官方订正——见 §4。
>
> 本文只答"接口长什么样"。**服务与工具行尚未实现**（见 §8 的落地建议）。

---

## 0. 当前配置状态

| 项 | 值 |
| --- | --- |
| Token | **已配置**，存于仓库根 `.env.local` 的 `MINERU_TOKEN`（该文件被 `.gitignore` 的 `.env.*` 规则排除，**不入库**；模板见 `.env.example`） |
| Token 有效性 | **已验证**：带 token 请求返回参数校验错误、不带 token 返回 401（对照组），见 `tests/spike-mineru-api.mjs` |
| 服务可达性 | `mineru.net` 200 ✅（**不经代理**，国内直连；`scripts/start-dsh-web.ps1` 已把它放进 `NO_PROXY`） |
| 额度 | 每账号每天 **2000 页**最高优先级，超出部分优先级降低（不是拒绝） |

> 环境变量名 `MINERU_TOKEN` 是**本仓库的约定，不是官方要求**——官方只要求把 Token 放进
> `Authorization: Bearer` 头，没有规定环境变量名。

---

## 1. 两套 API 怎么选

| 对比维度 | 🎯 精准解析 API | ⚡ Agent 轻量解析 API |
| --- | --- | --- |
| 是否需要 Token | ✅ 需要 | ❌ 无需（**IP 限频**，超限 429） |
| Base URL | `https://mineru.net/api/v4` | `https://mineru.net/api/v1/agent` |
| 模型版本 | `pipeline`（默认）/ `vlm`（官方推荐）/ `MinerU-HTML` | 固定轻量 pipeline |
| 文件大小 | ≤ **200 MB** | ≤ 10 MB |
| 页数 | ≤ **600 页** | ≤ 20 页 |
| 批量 | ✅ ≤ **200 个/次** | ❌ 单文件 |
| 输出 | Zip：Markdown + JSON，可另导出 docx / html / latex | 仅 Markdown（CDN 链接） |
| 调用方式 | 异步：提交 → 轮询/回调 | 异步：提交 → 轮询 |

**本项目的选择**：走**精准解析 API**（有 token、需要批量、需要 600 页与 200MB 上限、可能要多格式导出）。
Agent API 留作"无 token 快速试一下"的备用。

---

## 2. 端点清单（全部实测存在）

### 2.1 精准解析 API

| 用途 | 方法与路径 | 实测响应（空/伪造参数） |
| --- | --- | --- |
| 单文件（URL）创建任务 | `POST /api/v4/extract/task` | `200 {"code":-10002,"msg":"field \"url\" is not set"}` |
| 批量（URL）创建任务 | `POST /api/v4/extract/task/batch` | `200 -10002 type mismatch for field "files"` |
| **本地文件批量上传** | `POST /api/v4/file-urls/batch` | `200 -10002 type mismatch for field "files"` |
| 查单个任务 | `GET /api/v4/extract/task/{task_id}` | `200 {"code":-60012,"msg":"task not found or expire"}` |
| 查批量结果 | `GET /api/v4/extract-results/batch/{batch_id}` | `200 -60012` |

### 2.0 真实解析链路的形状订正（2026-09-16，scripts/parse-one.mjs 端到端实测）

第一次端到端解析暴露两处与"空参数探测"不同的真实形状（已同步进 `MineruClient`）：

| 端点 | 真实形状 |
| --- | --- |
| `POST /file-urls/batch` 成功响应 | `data.file_urls` 是 **URL 字符串数组**（与 files 顺序一致，24h 有效），不是对象数组；`data.batch_id` 为 batch 标识 |
| `GET /extract-results/batch/{id}` | 结果字段名是 **`extract_result`**（不是 `results`）：`[{file_name, state, err_msg, full_zip_url}]`；轮询时认错字段名会永远等不到终态 |

实测全链路（1 篇 15 页 arXiv 论文）：提交 → 上传 → 轮询 done → 解压 31 个产物
（full.md + 图片 + json）→ 额度记账 +15 页。解析时长在分钟级（队列排队），
轮询间隔 8s、超时 15min 合适；命令超时可换 `scripts/resume-batch.mjs`
按 batch_id 续跑（不重复提交、不重复计费）。

### 2.2 Agent 轻量解析 API（免 Token）

| 用途 | 路径 | 实测响应 |
| --- | --- | --- |
| URL 解析 | `POST /api/v1/agent/parse/url` | `400 {"error":{"code":"invalid_request","message":"field \"url\" is not set",...}}` |
| 文件解析 | `POST /api/v1/agent/parse/file` | `400 ... field "file_name" is not set` |
| 查结果 | `GET /api/v1/agent/parse/{task_id}` | `200 {"code":-10002,"msg":"invalid task_id"}` |

> Agent API 的错误信封与精准 API **不同**：前者是 `{"error":{code,message,param,type}}`（HTTP 400），
> 后者是 `{"code":-10002,"msg":"..."}`（HTTP 200 但 `code != 0`）。客户端要分别处理。

---

## 3. 鉴权

```
Authorization: Bearer <MINERU_TOKEN>
Content-Type: application/json
```

失败时的两种形态（**都出现过**，客户端要都认）：

| 场景 | 响应 |
| --- | --- |
| 未带 token（网关层） | `401` + 纯文本 `login required` |
| token 无效 / 过期（业务层） | `{"success":false,"msgCode":"A0202","msg":"user authenticate failed"}` |

> 判据：**HTTP 200 且 `code: 0`** 才算成功。`code != 0` 时 HTTP 仍是 200，别只判状态码。

---

## 4. 限流与额度（官方原文）

| 类别 | 限制 |
| --- | --- |
| **提交任务类**（`extract/task` + `file-urls/batch` + `extract/task/batch`，**共用一个频控**） | **300 次/分钟** |
| **获取结果类**（`extract/task/{id}` + `extract-results/batch/{id}`，**共用一个频控**） | **1000 次/分钟** |
| 每日上传文件数 | 单用户 **≤ 10,000 个/天**，其中 **HTML ≤ 100 个** |
| 解析额度 | 每账号每天 **2000 页最高优先级**；超出部分优先级降低（不是拒绝） |

官方保留按系统负载**动态调整**限流的权利，超限请求会被拒绝。需要更高配额联系
`opendatalab@pjlab.org.cn`。

### ⚠️ 与第三方参考的三处不符（以官方为准）

| 项 | 第三方（Nebutra/MinerU-Skill） | **官方** |
| --- | --- | --- |
| 单文件页数上限 | ≤ 200 页 | **≤ 600 页** |
| 批量文件数上限 | ≤ 50 个/次 | **≤ 200 个** |
| 免费额度 | 1000 页/天 | **2000 页/天** |

（Agent API 的 ≤20 页 / ≤10MB、精准 API 的 ≤200MB 三者一致。）

### 对轮询间隔的约束

"提交"300 次/分、"查询"1000 次/分。按一批 200 个文件估：一次批量提交 + 轮询，
轮询间隔取 **5–10 秒**即可长时间停在限额内；不要用毫秒级轮询。

---

## 5. 请求参数（`POST /api/v4/extract/task`）

| 参数 | 类型 | 必选 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `url` | string | **是** | — | 文件 URL（**见 §8 的境外 URL 陷阱**） |
| `model_version` | string | 否 | `pipeline` | `pipeline` / `vlm`（官方推荐）/ `MinerU-HTML`（仅 HTML 文件，**必须显式指定**） |
| `is_ocr` | bool | 否 | `false` | 仅对 pipeline / vlm 有效 |
| `enable_formula` | bool | 否 | `true` | 对 vlm 仅影响**行内**公式 |
| `enable_table` | bool | 否 | `true` | |
| `language` | string | 否 | `ch` | OCR 语言 |
| `page_ranges` | string | 否 | 全部 | 逗号分隔，如 `"2,4-6"`；支持负数索引，如 `"2--2"` 表示第 2 页到倒数第 2 页 |
| `extra_formats` | string[] | 否 | `[]` | 仅支持 `docx` / `html` / `latex`；对源文件为 HTML 的无效 |
| `data_id` | string | 否 | — | 业务侧标识，`[A-Za-z0-9_.-]`，≤128 字符；查询时会回传 |
| `callback` | string | 否 | — | 结果推送地址（**见 §8**） |
| `seed` | string | 否 | — | 用 `callback` 时**必须**提供；用于校验 checksum |
| `no_cache` | bool | 否 | `false` | 绕过 URL 内容缓存 |
| `cache_tolerance` | int | 否 | `900` | 缓存容忍秒数；仅在 `no_cache=false` 时有效 |

成功响应：

```json
{ "code": 0, "msg": "ok", "trace_id": "...", "data": { "task_id": "a90e6ab6-..." } }
```

`trace_id` 建议记入日志——排查时官方要它。

---

## 6. 任务状态与进度

`GET /api/v4/extract/task/{task_id}` 的 `data.state`：

| state | 含义 |
| --- | --- |
| `pending` | 排队中 |
| `running` | 正在解析（此时 `data.extract_progress` 有效） |
| `converting` | 格式转换中 |
| `done` | 完成（此时 `data.full_zip_url` 有效） |
| `failed` | 失败（此时 `data.err_msg` 有效） |

`running` 时可用字段：`extract_progress.extracted_pages` / `.total_pages` / `.start_time`
——**可直接用于进度上报**，不必自己估算。

结果 zip 内容：`full.md`（Markdown）、`layout.json`（对应 middle.json）、`*_model.json`（模型推理结果）、
`*_content_list.json`（内容列表）。HTML 源文件稍有不同：`full.md` + `main.html`。

---

## 7. 错误码

**实测确认**的（2026-09-16）：

| 码 | 含义 |
| --- | --- |
| `-10002` | 参数错误（如缺 `url`、`files` 类型不符） |
| `-60012` | `task not found or expire` |
| HTTP `401` + `login required` | 未带 token |
| `A0202` | token 无效（网关层信封） |

**第三方转述、本仓库尚未逐条验证**（列出备查，用到时先核实）：

| 码 | 含义 |
| --- | --- |
| `A0211` | token 过期 |
| `-500` / `-10001` | 参数错误 / 服务错误 |
| `-60002` ~ `-60008` | 不支持的格式 / 文件读取失败 / 空文件 / 文件过大 / 页数超限 / 读取超时 |
| `-60010` | 解析失败 |
| `-60015` / `-60016` | 文件 / 格式转换失败 |
| `-60018` | 当日额度用尽 |
| `-60022` | 网页读取失败（限流） |
| `-30001` ~ `-30004` | Agent API：超 10MB / 格式不支持 / 超 20 页 / 参数非法 |

---

## 8. 集成要点（对本项目）

### 8.1 ⚠️ 境外 URL 会超时 —— 所以"上传优先"，不要丢 URL

官方原文：「**因网络限制，github、aws 等国外 URL 会请求超时**」。

我们的论文 PDF 绝大多数托管在境外（arXiv、出版社、PMC），**直接把 URL 交给 MinerU 大概率超时**。
正确链路是：

```
Asta / 人工给出 DOI
      ↓
paper-fetch skill  →  把 PDF 落到本地（七源回退，OA 优先）
      ↓
POST /api/v4/file-urls/batch   →  拿签名上传链接（有效期 24h）
      ↓  PUT 本地文件（无需 Content-Type）
系统自动扫描并提交解析（**无需再调提交接口**）
      ↓
GET /api/v4/extract-results/batch/{batch_id}   →  取 full_zip_url
```

这也解释了为什么 `paper-fetch` 与 MinerU 是互补而不是重复：**前者负责"拿到文件"，后者负责"读懂文件"**。

### 8.2 callback 还是轮询

- **callback**：传 `callback` + `seed`，结果 POST 到你的地址（UTF-8 / JSON），
  `checksum = SHA256(uid + seed + content)`，接收失败最多重推 5 次。适合无人值守流水线。
- **轮询**：实现简单，但要自己控频率（§4）。Python 侧注意 `data.state` 的
  `converting` 也算未完成。

项目未实现前建议先用轮询（少一个对外可达端点），等 C 模式无人值守时再上 callback。

### 8.3 落位建议（未定，待实现时确认）

按勘误 §4.4.1 已冻结的判定规则：**跨项目的资源账本必须放宿主组合**。MinerU 的
"2000 页/天"额度是**跨项目共享**的，因此：

- **解析工具行**可以随 preset；
- **额度记账**（今日已用页数、剩余优先级额度）应和 GPU / 预算账本一起放**宿主平面**，
  否则两个项目各自记账会绕过上限。

此判定尚未落地，实现 MinerU 服务时需一并处理。

### 8.4 合规

`NOTICE.md` 合规红线相关：上传的 PDF **会离开本机**到达 mineru.net（上海 AI 实验室），
**敏感 / 未公开材料不要送**；仅解析已公开的论文。

---

## 9. 复现方式

```powershell
# Token 有效性 + 两套 API 可达性（不消耗额度：用错误类型区分鉴权与参数）
$env:MINERU_TOKEN = (Select-String -Path .env.local -Pattern '^MINERU_TOKEN=(.+)$').Matches.Groups[1].Value
node tests/spike-mineru-api.mjs
```

预期输出 `MINERU API SPIKE OK —— token 有效、服务可达、探测不消耗额度`。

> 该 spike 的手法值得复用：**带 token 发空 body 应得到参数错误（证明过了鉴权），
> 不带 token 应得到 401（对照组）**——这样探测不会真的创建解析任务、不消耗额度。
