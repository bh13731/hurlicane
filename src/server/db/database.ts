// @ts-ignore — node:sqlite is experimental in Node ≥22 and has no @types yet
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Additive migrations — safe to run repeatedly
  const jobCols: string[] = (db.prepare('PRAGMA table_info(jobs)').all() as any[]).map((r: any) => r.name);
  if (!jobCols.includes('model')) {
    db.exec('ALTER TABLE jobs ADD COLUMN model TEXT');
  }
  if (!jobCols.includes('template_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN template_id TEXT REFERENCES templates(id)');
  }
  if (!jobCols.includes('flagged')) {
    db.exec('ALTER TABLE jobs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('depends_on')) {
    db.exec('ALTER TABLE jobs ADD COLUMN depends_on TEXT');
  }
  if (!jobCols.includes('is_interactive')) {
    db.exec('ALTER TABLE jobs ADD COLUMN is_interactive INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('use_worktree')) {
    db.exec('ALTER TABLE jobs ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('is_readonly')) {
    db.exec('ALTER TABLE jobs ADD COLUMN is_readonly INTEGER NOT NULL DEFAULT 0');
  }

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  if (!jobCols.includes('project_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id)');

  const agentCols: string[] = (db.prepare('PRAGMA table_info(agents)').all() as any[]).map((r: any) => r.name);
  if (!agentCols.includes('parent_agent_id')) {
    db.exec('ALTER TABLE agents ADD COLUMN parent_agent_id TEXT');
  }
  if (!agentCols.includes('base_sha')) {
    db.exec('ALTER TABLE agents ADD COLUMN base_sha TEXT');
  }
  if (!agentCols.includes('diff')) {
    db.exec('ALTER TABLE agents ADD COLUMN diff TEXT');
  }
  if (!agentCols.includes('cost_usd')) {
    db.exec('ALTER TABLE agents ADD COLUMN cost_usd REAL');
  }
  if (!agentCols.includes('duration_ms')) {
    db.exec('ALTER TABLE agents ADD COLUMN duration_ms INTEGER');
  }
  if (!agentCols.includes('num_turns')) {
    db.exec('ALTER TABLE agents ADD COLUMN num_turns INTEGER');
  }
  if (!agentCols.includes('pending_wait_ids')) {
    db.exec('ALTER TABLE agents ADD COLUMN pending_wait_ids TEXT');
  }

  // FTS5 virtual table for full-text search across agent output
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS output_fts USING fts5(
      text_content,
      agent_id UNINDEXED
    )
  `);

  const tplCols: string[] = (db.prepare('PRAGMA table_info(templates)').all() as any[]).map((r: any) => r.name);
  if (!tplCols.includes('work_dir')) {
    db.exec('ALTER TABLE templates ADD COLUMN work_dir TEXT');
  }
  if (!tplCols.includes('model')) {
    db.exec('ALTER TABLE templates ADD COLUMN model TEXT');
  }
  if (!tplCols.includes('is_readonly')) {
    db.exec('ALTER TABLE templates ADD COLUMN is_readonly INTEGER NOT NULL DEFAULT 0');
  }

  // Batch templates
  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_templates (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      items      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Notes (shared scratchpad across all agents)
  const notesCols: string[] = (db.prepare('PRAGMA table_info(notes)').all() as any[]).map((r: any) => r.name);
  if (notesCols.length === 0) {
    db.exec(`
      CREATE TABLE notes (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        agent_id   TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  if (!jobCols.includes('scheduled_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN scheduled_at INTEGER');
  }
  if (!jobCols.includes('repeat_interval_ms')) {
    db.exec('ALTER TABLE jobs ADD COLUMN repeat_interval_ms INTEGER');
  }
  if (!jobCols.includes('retry_policy')) {
    db.exec("ALTER TABLE jobs ADD COLUMN retry_policy TEXT NOT NULL DEFAULT 'none'");
  }
  if (!jobCols.includes('max_retries')) {
    db.exec('ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('retry_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!jobCols.includes('original_job_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN original_job_id TEXT');
  }
  if (!jobCols.includes('completion_checks')) {
    db.exec('ALTER TABLE jobs ADD COLUMN completion_checks TEXT');
  }
  // ── Feature 6: Agent Health Monitoring ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_warnings (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      type       TEXT NOT NULL,
      message    TEXT NOT NULL,
      dismissed  INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_warnings_agent ON agent_warnings(agent_id, dismissed)');

  // ── Repos — additive migrations ────────────────────────────────────────────
  const repoCols: string[] = (db.prepare('PRAGMA table_info(repos)').all() as any[]).map((r: any) => r.name);
  if (!repoCols.includes('url')) {
    db.exec("ALTER TABLE repos ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  }
  if (!repoCols.includes('default_branch')) {
    db.exec("ALTER TABLE repos ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'");
  }
  if (!repoCols.includes('instructions')) {
    db.exec("ALTER TABLE repos ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
  }

  // ── Worktrees — additive migrations ───────────────────────────────────────
  const wtCols: string[] = (db.prepare('PRAGMA table_info(worktrees)').all() as any[]).map((r: any) => r.name);
  if (!wtCols.includes('repo_id')) {
    db.exec("ALTER TABLE worktrees ADD COLUMN repo_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_repo ON worktrees(repo_id)');

  // ── Feature 1: Mid-Task Nudge ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudges (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      message      TEXT NOT NULL,
      delivered    INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_nudges_agent ON nudges(agent_id, delivered)');

  // ── Feature 5: Knowledge Base ─────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      tags       TEXT,
      source     TEXT,
      agent_id   TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
      title,
      content,
      kb_id UNINDEXED
    )
  `);

  // last_hit_at column on knowledge_base — tracks when entries are actually matched/used
  const kbCols: string[] = (db.prepare('PRAGMA table_info(knowledge_base)').all() as any[]).map((r: any) => r.name);
  if (!kbCols.includes('last_hit_at')) {
    db.exec('ALTER TABLE knowledge_base ADD COLUMN last_hit_at INTEGER');
  }

  if (!jobCols.includes('archived_at')) {
    db.exec('ALTER TABLE jobs ADD COLUMN archived_at INTEGER');
  }
  if (!jobCols.includes('created_by_agent_id')) {
    db.exec('ALTER TABLE jobs ADD COLUMN created_by_agent_id TEXT');
  }

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
