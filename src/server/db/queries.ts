import { getDb } from './database.js';
import type { Job, Agent, AgentWithJob, ChildAgentSummary, Question, FileLock, AgentOutput, AgentOutputSegment, Template, Note, JobStatus, AgentStatus, SearchResult } from '../../shared/types.js';

// node:sqlite returns null-prototype objects; cast them via JSON round-trip helper
function cast<T>(val: unknown): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export function insertJob(job: {
  id: string;
  title: string;
  description: string;
  context: string | null;
  priority: number;
  status?: JobStatus;
  work_dir?: string | null;
  max_turns?: number;
  model?: string | null;
  template_id?: string | null;
  depends_on?: string | null;
  is_interactive?: number;
  use_worktree?: number;
}): Job {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO jobs (id, title, description, context, status, priority, work_dir, max_turns, model, template_id, depends_on, is_interactive, use_worktree, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id, job.title, job.description, job.context,
    job.status ?? 'queued', job.priority,
    job.work_dir ?? null, job.max_turns ?? 50,
    job.model ?? null,
    job.template_id ?? null,
    job.depends_on ?? null,
    job.is_interactive ?? 0,
    job.use_worktree ?? 0,
    now, now
  );
  return getJobById(job.id)!;
}

export function getJobById(id: string): Job | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? cast<Job>(row) : null;
}

export function listJobs(status?: JobStatus): Job[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM jobs ORDER BY priority DESC, created_at ASC').all();
  }
  return rows.map(r => cast<Job>(r));
}

export function updateJobStatus(id: string, status: JobStatus): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
}

export function updateJobModel(id: string, model: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET model = ?, updated_at = ? WHERE id = ?').run(model, Date.now(), id);
}

export function updateJobTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
}

export function updateJobFlagged(id: string, flagged: number): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET flagged = ?, updated_at = ? WHERE id = ?').run(flagged, Date.now(), id);
}

export function getNextQueuedJob(): Job | null {
  const db = getDb();
  // Skip jobs whose dependencies have not all completed successfully
  const row = db.prepare(`
    SELECT * FROM jobs j
    WHERE j.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(COALESCE(j.depends_on, '[]')) dep
        JOIN jobs d ON d.id = dep.value
        WHERE d.status != 'done'
      )
    ORDER BY j.priority DESC, j.created_at ASC LIMIT 1
  `).get();
  return row ? cast<Job>(row) : null;
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export function insertAgent(agent: { id: string; job_id: string } & Partial<Agent>): Agent {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (id, job_id, status, pid, session_id, parent_agent_id, exit_code, error_message, status_message, output_read, started_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id, agent.job_id,
    agent.status ?? 'starting',
    agent.pid ?? null, agent.session_id ?? null,
    agent.parent_agent_id ?? null,
    agent.exit_code ?? null, agent.error_message ?? null,
    agent.status_message ?? null,
    agent.output_read ?? 0,
    agent.started_at ?? now, agent.updated_at ?? now,
    agent.finished_at ?? null
  );
  return getAgentById(agent.id)!;
}

export function getAgentById(id: string): Agent | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? cast<Agent>(row) : null;
}

export function listAgents(status?: AgentStatus): Agent[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY started_at DESC').all(status);
  } else {
    rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  }
  return rows.map(r => cast<Agent>(r));
}

export function updateAgent(id: string, fields: Partial<Pick<Agent, 'status' | 'pid' | 'session_id' | 'exit_code' | 'error_message' | 'status_message' | 'output_read' | 'base_sha' | 'diff' | 'cost_usd' | 'duration_ms' | 'num_turns' | 'finished_at'>>): void {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function listBatchAgents(status?: AgentStatus): Agent[] {
  const db = getDb();
  let rows: unknown[];
  if (status) {
    rows = db.prepare(`
      SELECT a.* FROM agents a
      JOIN jobs j ON j.id = a.job_id
      WHERE a.status = ? AND COALESCE(j.is_interactive, 0) = 0
      ORDER BY a.started_at DESC
    `).all(status);
  } else {
    rows = db.prepare(`
      SELECT a.* FROM agents a
      JOIN jobs j ON j.id = a.job_id
      WHERE COALESCE(j.is_interactive, 0) = 0
      ORDER BY a.started_at DESC
    `).all();
  }
  return (rows as unknown[]).map(r => cast<Agent>(r));
}

export function listRunningInteractiveAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.* FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.is_interactive = 1
      AND a.status IN ('starting', 'running', 'waiting_user')
  `).all();
  return (rows as unknown[]).map(r => cast<Agent>(r));
}

export function getAgentsWithJob(): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY started_at DESC').all();
  return rows.map(r => enrichAgent(cast<Agent>(r)));
}

export function getAgentsWithJobByJobId(jobId: string): AgentWithJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents WHERE job_id = ? ORDER BY started_at DESC').all(jobId);
  return (rows as unknown[]).map(r => enrichAgent(cast<Agent>(r)));
}

export function getAgentWithJob(id: string): AgentWithJob | null {
  const agent = getAgentById(id);
  if (!agent) return null;
  return enrichAgent(agent);
}

function getChildAgentSummaries(agentId: string): ChildAgentSummary[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.id, a.status, j.title as job_title, j.description as job_description
    FROM agents a
    JOIN jobs j ON j.id = a.job_id
    WHERE a.parent_agent_id = ?
    ORDER BY a.started_at ASC
  `).all(agentId);
  return rows.map(r => cast<ChildAgentSummary>(r));
}

function enrichAgent(agent: Agent): AgentWithJob {
  const db = getDb();
  const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(agent.job_id);
  const job = cast<Job>(jobRow);
  const qRow = db.prepare(`
    SELECT * FROM questions WHERE agent_id = ? AND status = 'pending' ORDER BY asked_at DESC LIMIT 1
  `).get(agent.id);
  const pending_question = qRow ? cast<Question>(qRow) : null;
  const lockRows = db.prepare(`
    SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL
  `).all(agent.id);
  const active_locks = lockRows.map(r => cast<FileLock>(r));
  const child_agents = getChildAgentSummaries(agent.id);
  let template_name: string | null = null;
  if (job.template_id) {
    const tRow = db.prepare('SELECT name FROM templates WHERE id = ?').get(job.template_id) as { name: string } | undefined;
    template_name = tRow?.name ?? null;
  }
  return { ...agent, job, template_name, pending_question, active_locks, child_agents };
}

// ─── Agent Output ─────────────────────────────────────────────────────────────

function extractSearchText(content: string): string {
  try {
    const ev = JSON.parse(content);
    if (ev.type === 'assistant' && ev.message?.content) {
      return (ev.message.content as any[])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join(' ');
    }
    if (ev.type === 'result') return ev.result ?? '';
    if (ev.type === 'error') return ev.error?.message ?? '';
    return '';
  } catch { return ''; }
}

export function insertAgentOutput(output: Omit<AgentOutput, 'id'>): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_output (agent_id, seq, event_type, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(output.agent_id, output.seq, output.event_type, output.content, output.created_at);

  // Index in FTS table (skip empty text)
  const text = extractSearchText(output.content);
  if (text.trim()) {
    const row = db.prepare('SELECT id FROM agent_output WHERE agent_id = ? AND seq = ?').get(output.agent_id, output.seq) as { id: number } | undefined;
    if (row) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(row.id, text, output.agent_id);
    }
  }
}

export function rebuildFts(): void {
  const db = getDb();
  // Repopulate FTS for any rows not yet indexed (rowid lookup in FTS5 is O(1))
  const rows = db.prepare('SELECT id, agent_id, content FROM agent_output').all() as Array<{ id: number; agent_id: string; content: string }>;
  let added = 0;
  for (const row of rows) {
    const text = extractSearchText(row.content);
    if (!text.trim()) continue;
    const exists = db.prepare('SELECT rowid FROM output_fts WHERE rowid = ?').get(row.id);
    if (!exists) {
      db.prepare('INSERT INTO output_fts(rowid, text_content, agent_id) VALUES (?, ?, ?)').run(row.id, text, row.agent_id);
      added++;
    }
  }
  if (added > 0) console.log(`[fts] indexed ${added} new output rows`);
}

export function searchOutputs(query: string, limit = 50): SearchResult[] {
  const db = getDb();
  const sql = `
    SELECT
      f.agent_id,
      snippet(output_fts, 0, '<mark>', '</mark>', '…', 20) as excerpt,
      ao.seq, ao.event_type,
      a.status as agent_status,
      j.id as job_id, j.title as job_title
    FROM output_fts f
    JOIN agent_output ao ON ao.id = f.rowid
    JOIN agents a ON a.id = f.agent_id
    JOIN jobs j ON j.id = a.job_id
    WHERE output_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const rows = db.prepare(sql).all(query, limit) as any[];
    return rows.map(r => cast<SearchResult>({ ...r }));
  } catch {
    // Invalid FTS query — try as quoted phrase
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const rows = db.prepare(sql).all(escaped, limit) as any[];
      return rows.map(r => cast<SearchResult>({ ...r }));
    } catch { return []; }
  }
}

export function getAgentOutput(agentId: string): AgentOutput[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq ASC').all(agentId);
  return rows.map(r => cast<AgentOutput>(r));
}

export function getLatestAgentOutput(agentId: string): AgentOutput | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT 1').get(agentId);
  return row ? cast<AgentOutput>(row) : null;
}

export function getAgentFullOutput(agentId: string): AgentOutputSegment[] {
  // Walk the parent chain to build oldest-first list of agents
  const chain: Agent[] = [];
  let current = getAgentById(agentId);
  while (current) {
    chain.unshift(current);
    if (!current.parent_agent_id) break;
    current = getAgentById(current.parent_agent_id);
  }

  return chain.map(agent => {
    const job = getJobById(agent.job_id)!;
    const output = getAgentOutput(agent.id);
    return { agent_id: agent.id, job_title: job.title, job_description: job.description, output };
  });
}

export function getAgentLastSeq(agentId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT MAX(seq) as last_seq FROM agent_output WHERE agent_id = ?').get(agentId);
  const v = cast<{ last_seq: number | null }>(row);
  return v.last_seq ?? -1;
}

// ─── Questions ────────────────────────────────────────────────────────────────

export function insertQuestion(question: Question): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO questions (id, agent_id, question, answer, status, asked_at, answered_at, timeout_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    question.id, question.agent_id, question.question,
    question.answer, question.status,
    question.asked_at, question.answered_at, question.timeout_ms
  );
}

export function getQuestionById(id: string): Question | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? cast<Question>(row) : null;
}

export function updateQuestion(id: string, fields: Partial<Pick<Question, 'answer' | 'status' | 'answered_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getPendingQuestion(agentId: string): Question | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM questions WHERE agent_id = ? AND status = 'pending' ORDER BY asked_at DESC LIMIT 1
  `).get(agentId);
  return row ? cast<Question>(row) : null;
}

// ─── File Locks ───────────────────────────────────────────────────────────────

export function insertFileLock(lock: FileLock): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_locks (id, agent_id, file_path, reason, acquired_at, expires_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(lock.id, lock.agent_id, lock.file_path, lock.reason, lock.acquired_at, lock.expires_at, lock.released_at);
}

export function getFileLockById(id: string): FileLock | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM file_locks WHERE id = ?').get(id);
  return row ? cast<FileLock>(row) : null;
}

export function getActiveLocksForFile(filePath: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path = ? AND released_at IS NULL AND expires_at > ?
  `).all(filePath, now);
  return rows.map(r => cast<FileLock>(r));
}

export function getActiveLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL AND expires_at > ?
  `).all(agentId, now);
  return rows.map(r => cast<FileLock>(r));
}

export function getAllActiveLocks(): FileLock[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE released_at IS NULL AND expires_at > ?
  `).all(now);
  return rows.map(r => cast<FileLock>(r));
}

export function releaseLock(id: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE id = ?').run(Date.now(), id);
}

export function releaseLocksForAgent(agentId: string): void {
  const db = getDb();
  db.prepare('UPDATE file_locks SET released_at = ? WHERE agent_id = ? AND released_at IS NULL').run(Date.now(), agentId);
}

// Returns all unreleased locks for an agent regardless of TTL expiry.
// Used by releaseAll so that expired-but-unreleased locks still emit lock:released events.
export function getAllUnreleasedLocksForAgent(agentId: string): FileLock[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM file_locks WHERE agent_id = ? AND released_at IS NULL'
  ).all(agentId);
  return rows.map(r => cast<FileLock>(r));
}

export function getActiveLocksForFiles(filePaths: string[]): FileLock[] {
  if (filePaths.length === 0) return [];
  const db = getDb();
  const now = Date.now();
  const placeholders = filePaths.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM file_locks WHERE file_path IN (${placeholders}) AND released_at IS NULL AND expires_at > ?
  `).all(...filePaths, now);
  return rows.map(r => cast<FileLock>(r));
}

// ─── Templates ────────────────────────────────────────────────────────────────

export function insertTemplate(template: Template): Template {
  const db = getDb();
  db.prepare(`
    INSERT INTO templates (id, name, content, work_dir, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(template.id, template.name, template.content, template.work_dir ?? null, template.model ?? null, template.created_at, template.updated_at);
  return getTemplateById(template.id)!;
}

export function getTemplateById(id: string): Template | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
  return row ? cast<Template>(row) : null;
}

export function listTemplates(): Template[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
  return rows.map(r => cast<Template>(r));
}

export function updateTemplate(id: string, fields: Partial<Pick<Template, 'name' | 'content' | 'work_dir' | 'model'>>): Template | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getTemplateById(id);
}

export function deleteTemplate(id: string): void {
  const db = getDb();
  // Null out any jobs that referenced this template before deleting
  db.prepare('UPDATE jobs SET template_id = NULL WHERE template_id = ?').run(id);
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

// ─── Notes (shared scratchpad) ────────────────────────────────────────────────

export function upsertNote(key: string, value: string, agentId: string | null): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO notes (key, value, agent_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, agent_id = excluded.agent_id, updated_at = excluded.updated_at
  `).run(key, value, agentId, Date.now());
}

export function getNote(key: string): Note | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM notes WHERE key = ?').get(key);
  return row ? cast<Note>(row) : null;
}

export function listNotes(prefix?: string): Note[] {
  const db = getDb();
  let rows: unknown[];
  if (prefix) {
    rows = db.prepare("SELECT * FROM notes WHERE key LIKE ? ORDER BY key ASC").all(prefix.replace(/%/g, '\\%') + '%');
  } else {
    rows = db.prepare('SELECT * FROM notes ORDER BY key ASC').all();
  }
  return rows.map(r => cast<Note>(r));
}

// ─── Agent result text ────────────────────────────────────────────────────────

export function getAgentResultText(agentId: string): string | null {
  const db = getDb();
  // Walk agent output in reverse to find the last result event
  const rows = db.prepare(`
    SELECT content FROM agent_output WHERE agent_id = ? ORDER BY seq DESC LIMIT 50
  `).all(agentId) as Array<{ content: string }>;
  for (const row of rows) {
    try {
      const ev = JSON.parse(row.content);
      if (ev.type === 'result' && typeof ev.result === 'string') {
        return ev.result;
      }
    } catch { /* skip */ }
  }
  return null;
}
