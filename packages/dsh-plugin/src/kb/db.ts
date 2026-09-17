/**
 * metadata.db：SQLite 连接、迁移框架与冻结 DDL（dsh 侧落地点）。
 *
 * 依据：勘误 §7.5.2（已冻结）——papers 表（含 `source_channel`）、三库同构表、
 * 两张注册表、`schema_migrations` 迁移纪律、索引清单。
 *
 * 选型：Node 内置 `node:sqlite`（SQLite 3.53+），零原生依赖，pnpm install 即用。
 * 向量索引不在本文件范围（Phase 3 选型后以 vec0 虚拟表外挂，§17.2）。
 */

import { DatabaseSync } from 'node:sqlite'

/** 一条迁移：版本号 + 幂等由 schema_migrations 保证。 */
export interface Migration {
  readonly version: number
  readonly up: string
}

/**
 * 冻结的迁移清单。
 *
 * 纪律（§7.5.2 第 5 点）：本清单冻结后的任何结构改动**只能追加**新版本，
 * 禁止修改已发布的迁移条目——已应用的库依赖旧条目的字节级一致。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE papers (
        paper_id          TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        authors           TEXT NOT NULL DEFAULT '[]',
        year              INTEGER,
        venue             TEXT,
        citation_count    INTEGER,
        doi               TEXT,
        arxiv_id          TEXT,
        pmid              TEXT,
        url               TEXT,
        oa_pdf_url        TEXT,
        abstract          TEXT,
        source_channel    TEXT NOT NULL DEFAULT 'manual'
                          CHECK(source_channel IN ('asta','ai4scholar','manual')),
        pdf_status        TEXT NOT NULL DEFAULT 'pending'
                          CHECK(pdf_status IN ('pending','downloaded','missing')),
        parse_channel     TEXT CHECK(parse_channel IN ('mineru','quick_read',NULL)),
        extraction_quality TEXT CHECK(extraction_quality IN ('full_text','abstract_only',NULL)),
        md_path           TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_papers_doi   ON papers(doi);
      CREATE INDEX idx_papers_arxiv ON papers(arxiv_id);
      CREATE INDEX idx_papers_pmid  ON papers(pmid);
      CREATE INDEX idx_papers_title ON papers(title);
      CREATE INDEX idx_papers_year  ON papers(year);

      CREATE TABLE problems (
        entry_id      TEXT PRIMARY KEY,
        statement     TEXT NOT NULL,
        ext           TEXT NOT NULL DEFAULT '{}',
        source_papers TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE TABLE methods (
        entry_id      TEXT PRIMARY KEY,
        statement     TEXT NOT NULL,
        ext           TEXT NOT NULL DEFAULT '{}',
        source_papers TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE TABLE innovations (
        entry_id      TEXT PRIMARY KEY,
        statement     TEXT NOT NULL,
        ext           TEXT NOT NULL DEFAULT '{}',
        source_papers TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

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
    `,
  },
  {
    // 冻结后追加（纪律：只加新版本，不改 v1）：本地 PDF 路径——
    // P2-5 落盘流水线要用它把 PDF 喂给 MinerU。
    version: 2,
    up: `
      ALTER TABLE papers ADD COLUMN pdf_path TEXT;
    `,
  },
  {
    // P2-6：Reader 结构化提取结果（v1.2 §5.3 十字段契约）。
    version: 3,
    up: `
      CREATE TABLE paper_extractions (
        paper_id          TEXT PRIMARY KEY,
        problem_statement TEXT NOT NULL,
        method_summary    TEXT NOT NULL,
        innovations       TEXT NOT NULL DEFAULT '[]',
        future_work       TEXT NOT NULL DEFAULT '[]',
        limitations       TEXT NOT NULL DEFAULT '[]',
        benchmark         TEXT NOT NULL DEFAULT '[]',
        metrics           TEXT NOT NULL DEFAULT '[]',
        baseline_methods  TEXT NOT NULL DEFAULT '[]',
        extraction_quality TEXT NOT NULL,
        extracted_at      TEXT NOT NULL
      );
    `,
  },
  {
    // P3-1：三库全文检索（`cvagent_kb_search` 的底座）。
    //
    // 选型依据是 S4 spike 的实测（`scripts/spike-s4-retrieval.mjs`，2026-09-17）：
    // - **不需要向量索引**：1000 条 × 768 维暴力全扫仅 1.19ms，三库规模远在其下；
    // - **FTS5 可用**，但中文必须用 `trigram` 分词器（默认 unicode61 对中文不做词切分，
    //   整串成一个 token，子串查不到）；
    // - trigram 的硬限制：**查询串须 ≥3 字符**（2 字中文查不到）。因此 TriLibrary.search
    //   对 <3 字符的查询回退 `LIKE`——两条路径都要有，否则「泛化」这类两字查询会静默返回空。
    //
    // 形态：external-content FTS5（`content='<表名>'`）+ 三个触发器保持同步。
    // 用 external content 而不是 contentless，是为了让 `rebuild` 能在任何时刻
    // 从基表重建索引（迁移里已对既有条目执行一次），不需要我们手工维护镜像。
    version: 4,
    up: `
      CREATE VIRTUAL TABLE problems_fts USING fts5(
        statement, content='problems', content_rowid='rowid', tokenize='trigram'
      );
      CREATE VIRTUAL TABLE methods_fts USING fts5(
        statement, content='methods', content_rowid='rowid', tokenize='trigram'
      );
      CREATE VIRTUAL TABLE innovations_fts USING fts5(
        statement, content='innovations', content_rowid='rowid', tokenize='trigram'
      );

      CREATE TRIGGER problems_fts_ai AFTER INSERT ON problems BEGIN
        INSERT INTO problems_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;
      CREATE TRIGGER problems_fts_ad AFTER DELETE ON problems BEGIN
        INSERT INTO problems_fts(problems_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
      END;
      CREATE TRIGGER problems_fts_au AFTER UPDATE ON problems BEGIN
        INSERT INTO problems_fts(problems_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
        INSERT INTO problems_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;

      CREATE TRIGGER methods_fts_ai AFTER INSERT ON methods BEGIN
        INSERT INTO methods_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;
      CREATE TRIGGER methods_fts_ad AFTER DELETE ON methods BEGIN
        INSERT INTO methods_fts(methods_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
      END;
      CREATE TRIGGER methods_fts_au AFTER UPDATE ON methods BEGIN
        INSERT INTO methods_fts(methods_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
        INSERT INTO methods_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;

      CREATE TRIGGER innovations_fts_ai AFTER INSERT ON innovations BEGIN
        INSERT INTO innovations_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;
      CREATE TRIGGER innovations_fts_ad AFTER DELETE ON innovations BEGIN
        INSERT INTO innovations_fts(innovations_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
      END;
      CREATE TRIGGER innovations_fts_au AFTER UPDATE ON innovations BEGIN
        INSERT INTO innovations_fts(innovations_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
        INSERT INTO innovations_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;

      INSERT INTO problems_fts(problems_fts) VALUES('rebuild');
      INSERT INTO methods_fts(methods_fts) VALUES('rebuild');
      INSERT INTO innovations_fts(innovations_fts) VALUES('rebuild');
    `,
  },
  {
    // P3-3c：**失败方法库**（第四库，2026-09-17 用户裁定，勘误 §12.2）。
    //
    // 与三库同构（entry_id / statement / ext / source_papers / 时间戳），
    // 同样配 FTS5 trigram 索引 + 三个同步触发器——理由与 v4 完全一致。
    // 前缀 `F`；一条失败 = 「某个做法在某个条件下不成立」。
    //
    // 用途：idea 生成后的**强制复查闸**（生成 → 复查 → 打分）。命中不直接丢弃，
    // 而是要求写明「为什么这次不一样」——因为失败条件会变（换数据集/换主干/算力）。
    version: 5,
    up: `
      CREATE TABLE failures (
        entry_id      TEXT PRIMARY KEY,
        statement     TEXT NOT NULL,
        ext           TEXT NOT NULL DEFAULT '{}',
        source_papers TEXT NOT NULL DEFAULT '[]',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE failures_fts USING fts5(
        statement, content='failures', content_rowid='rowid', tokenize='trigram'
      );

      CREATE TRIGGER failures_fts_ai AFTER INSERT ON failures BEGIN
        INSERT INTO failures_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;
      CREATE TRIGGER failures_fts_ad AFTER DELETE ON failures BEGIN
        INSERT INTO failures_fts(failures_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
      END;
      CREATE TRIGGER failures_fts_au AFTER UPDATE ON failures BEGIN
        INSERT INTO failures_fts(failures_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement);
        INSERT INTO failures_fts(rowid, statement) VALUES (new.rowid, new.statement);
      END;
    `,
  },
]

/** papers 表与三库+失败库的 SQLite 行形态。 */
export interface PaperRow {
  paper_id: string
  title: string
  authors: string
  year: number | null
  venue: string | null
  citation_count: number | null
  doi: string | null
  arxiv_id: string | null
  pmid: string | null
  url: string | null
  oa_pdf_url: string | null
  abstract: string | null
  source_channel: 'asta' | 'ai4scholar' | 'manual'
  pdf_status: 'pending' | 'downloaded' | 'missing'
  parse_channel: 'mineru' | 'quick_read' | null
  extraction_quality: 'full_text' | 'abstract_only' | null
  md_path: string | null
  pdf_path: string | null
  created_at: string
  updated_at: string
}

/** 论文库数据库连接。 */
export class PaperDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** 底层连接（内部使用；不要暴露给模型层）。 */
  get raw(): DatabaseSync {
    return this.db
  }

  close(): void {
    this.db.close()
  }

  /** 已应用的迁移版本（升序）。 */
  appliedMigrations(): number[] {
    return this.db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as { version: number }).version)
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    )
    const applied = new Set(this.appliedMigrations())
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.db.exec('BEGIN')
      try {
        this.db.exec(migration.up)
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw new Error(`metadata.db 迁移 v${migration.version} 失败（已回滚）：${(error as Error).message}`)
      }
    }
  }
}
