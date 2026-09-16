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
]

/** papers 表与三库的 SQLite 行形态。 */
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
