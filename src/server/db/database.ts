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

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
