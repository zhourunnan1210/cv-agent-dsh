# Phase 2 · 三库 schema 冻结提案（v1，待确认）

| 项目 | 内容 |
| --- | --- |
| 依据 | v1.2 §5.4 / §17.1 / §17.2 + 勘误 §4.4.1（服务平面）与 §7.5（asta / MinerU 裁定） |
| 性质 | **冻结提案**：确认后即成为 Phase 2 实现的唯一 schema 依据；后续改动走迁移脚本，不允许原地漂移 |
| 存储 | SQLite（`data/papers/metadata.db`），向量索引 **不在本次冻结范围**（Phase 3 选型后以 vec0 虚拟表外挂，§17.2） |
| 冻结原则 | 基础字段跨领域通用写死；**领域特定字段一律进 `ext` JSON 列**（Domain Pack 的 `schema-ext.yml` 声明，枚举值不进 DB CHECK） |

## 1. papers 表（论文元数据，唯一权威记录）

```sql
CREATE TABLE papers (
  paper_id        TEXT PRIMARY KEY,   -- DOI（规范化小写）或 arXiv ID；本地论文允许内部 ID local:<hash>
  title           TEXT NOT NULL,
  authors         TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
  year            INTEGER,
  venue           TEXT,
  citation_count  INTEGER,
  doi             TEXT,
  arxiv_id        TEXT,
  pmid            TEXT,
  url             TEXT,
  oa_pdf_url      TEXT,
  abstract        TEXT,
  source_channel  TEXT NOT NULL DEFAULT 'manual'
                  CHECK(source_channel IN ('asta','ai4scholar','manual')),
  pdf_status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK(pdf_status IN ('pending','downloaded','missing')),
  parse_channel   TEXT CHECK(parse_channel IN ('mineru','quick_read',NULL)),
  extraction_quality TEXT CHECK(extraction_quality IN ('full_text','abstract_only',NULL)),
  md_path         TEXT,               -- markdown/ 下相对路径
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_papers_doi      ON papers(doi);
CREATE INDEX idx_papers_arxiv    ON papers(arxiv_id);
CREATE INDEX idx_papers_pmid     ON papers(pmid);
CREATE INDEX idx_papers_title    ON papers(title);
CREATE INDEX idx_papers_year     ON papers(year);
```

**去重键**（`cvagent_kb_import_paper` 的合并判定，按优先级）：
1. `paper_id` 精确匹配（DOI / arXiv ID 归一化：小写、去掉 `arXiv:` 前缀、`https://doi.org/` 前缀）；
2. `doi` / `arxiv_id` / `pmid` 任一命中 → 合并元数据（保留较长 abstract、union authors）；
3. 标题归一化（去标点、小写、折叠空白）后匹配 → 人工复核级别，记录 `source_channel` 来源差异，不自动合并。

**与 v1.2 §17.1 的差异**：新增 `source_channel`（asta 裁定）；标题索引（本地百篇导入的去重与匹配需要）。

## 2. 三库表（基础字段统一，领域字段走 ext）

三张表**同构**（勘误冻结后的结构，字段与 `@cv-research/core` 的 `BaseEntry` 对齐）：

```sql
CREATE TABLE problems (
  entry_id      TEXT PRIMARY KEY,          -- P001 / M001 / I001
  statement     TEXT NOT NULL,             -- problem_statement / method_name / innovation_statement
  ext           TEXT NOT NULL DEFAULT '{}',-- 领域扩展：{"deepfake-detection": {...}}（pack 命名空间隔离）
  source_papers TEXT NOT NULL DEFAULT '[]',-- 来源论文 paper_id 数组
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE methods     ( /* 同上结构 */ );
CREATE TABLE innovations ( /* 同上结构 */ );
```

**设计要点（冻结说明）**：

| 点 | 决定 | 理由 |
| --- | --- | --- |
| 三库同构 | 是（`problems` / `methods` / `innovations` 同一列集） | 查询以「向量/全文检索 + 全条目读取」为主，§17.2 已论证 JSON 列优于 EAV |
| 主键名 | `entry_id`（不是 `problem_id` 等） | 与 core 的 `BaseEntry.entry_id` 一致，三库可共用工具与接口 |
| 扩展字段 | 全在 `ext`，**不建实体列** | 枚举值（`detection_target`、`paradigm`…）由 Domain Pack 声明；换领域零迁移 |
| 迁移策略 | 字段冻结后改动走 `schema_migrations` 表 + 版本号脚本；`ext` 内容变更不需要迁移 | 防原地漂移（E18/E19 系列教训的延续：结构变更必须有可回滚的路径） |
| 向量 | 不在本提案内 | Phase 3 选型（sqlite-vec 首选）后外挂 vec0 表，不动主表 |

## 3. 三库之外的两张注册表（§17.1 保留，本轮一并冻结）

```sql
CREATE TABLE domain_packs (
  pack_id   TEXT NOT NULL,
  version   TEXT NOT NULL,
  frozen_by TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  pack_path TEXT NOT NULL,
  PRIMARY KEY (pack_id, version)
);

CREATE TABLE project_pack_binding (
  project_id TEXT PRIMARY KEY,
  pack_id    TEXT NOT NULL,
  version    TEXT NOT NULL
);
```

## 4. 与 asta / MinerU 裁定的衔接

| 裁定 | 落点 |
| --- | --- |
| asta 检索通道 | `papers.source_channel = 'asta'`；asta 返回结构 → `cvagent_kb_import_paper` 的规范化映射表（通道适配器），**schema 不受通道影响** |
| MinerU API | `parse_channel = 'mineru'`；`md_path` / `assets/` 落盘；失败降级 `quick_read` + `extraction_quality = 'abstract_only'` |

## 5. 冻结后立即能做的事

1. `metadata.db` 初始化脚本 + 迁移框架（`schema_migrations`）；
2. `cvagent_kb_import_paper` 工具（规范化 + 去重键 + source_channel 落库）——**不依赖 asta 的具体形态**，输入就是规范化记录；
3. 本地百篇 PDF 的 `paper_id` 分配与元数据补全流程（需要 PDF 目录路径）。

## 待确认项（冻结前必须回答）

| # | 问题 | 阻塞什么 |
| --- | --- | --- |
| 1 | 本提案是否按原样冻结（尤其 `entry_id` 命名与 `source_channel` 枚举） | 全部 Phase 2 建表 |
| 2 | asta 通道的具体形态：工具名 / 返回字段 / Agent 如何调用 | 检索层适配器 |
| 3 | MinerU API 的 base URL 与凭证名（如 `MINERU_API_KEY`） | 落盘流水线 |
| 4 | 本地百篇 PDF 的目录路径 | 本地导入任务 |
