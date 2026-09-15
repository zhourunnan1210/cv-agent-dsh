# 第三方组件与许可合规

本仓库包含复制自上游的第三方代码。依 v1.2 文档 §11「许可合规」要求，各上游的 LICENSE 与版权声明一律保留在原位，不做修改。

## 直接收录（vendored）

| 组件 | 位置 | 版本 | 许可 | 上游 | 说明 |
| --- | --- | --- | --- | --- | --- |
| dsh-ai4scholar | `packages/vendor/dsh-ai4scholar/` | 0.3.7（基准提交 `27a026f`，2026-09-11） | MIT | https://github.com/literaf/dsh-ai4scholar | 学术检索 / 全文读取 / `auto_cite` / `sci_draw`，38 个工具。**复制入库二次开发，非 fork 后跟随上游**（v1.2 §1.4 策略）。上游 `LICENSE` 原件保留在该目录内。 |

> 该目录内的源码与 `LICENSE` 为上游原文；本仓库对其的修改必须登记在 `packages/vendor/README.md`，并保留上游版权声明。

## 运行时依赖（未复制源码，由包管理器安装）

| 组件 | 许可 | 用途 |
| --- | --- | --- |
| @deepseek-ai/dsh（含 Cordis 及各 `dsh-*` 包） | MIT | Agent 运行时底座 |
| @deepseek-ai/schemastery | MIT | 配置 Schema |
| MinerU（计划接入，未入库） | Apache-2.0 系 | PDF 深度解析（本地部署优先） |

## 合规红线（摘自 v1.2 §23，工程上必须强制）

1. **论文版权**：仅自动下载开放获取（OA）PDF。非 OA 论文只落盘元数据与摘要，PDF 由用户自行获取后放入 `pdfs/`。**Agent 不做绕过付费墙的抓取。**
2. **数据集协议**：FF++、DFDC 等需签署使用协议的数据集由用户本人申请与下载；Agent 只接收已授权的本地路径，不代为申请。
3. **API 合规**：遵守 Semantic Scholar / arXiv / Unpaywall 的 rate limit 与 ToS；Google Scholar 默认走官方或半官方渠道。
4. **密钥卫生**：所有 API key 走 dsh credentials wire API 或本地 `.env`（已 gitignore）。**密钥字面值不进入模型上下文、不写入日志、不进入 git。**
5. **学术诚信**：论文草稿中的引用必须来自 `auto_cite` 的真实检索结果，**禁止模型凭记忆生成引用**；材料包中的所有指标必须可溯源到具体实验运行记录（`exp_id`）。
