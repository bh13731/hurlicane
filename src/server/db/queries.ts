import { randomUUID } from 'crypto';
import { getDb } from './database.js';
import type { Job, KBEntry, Review, TemplateModelStat, ReviewStatus, Discussion, DiscussionMessage, DiscussionStatus, DiscussionCategory, DiscussionPriority, Proposal, ProposalMessage, ProposalStatus, ProposalCategory, ProposalComplexity, Workflow, WorkflowStatus, WorkflowPhase, StopMode, PrReview, PrReviewMessage } from '../../shared/types.js';

export * from './jobQueries.js';
export * from './agentQueries.js';
export * from './agentOutputQueries.js';
export * from './noteQueries.js';

// A raw database row before casting to a typed interface.
type DbRow = Record<string, unknown>;

// node:sqlite returns null-prototype objects; shallow-copy to a regular object.
// SQLite rows are always flat scalars so a shallow copy is sufficient and far
// cheaper than the JSON round-trip previously used here.
function cast<T>(val: unknown): T {
  return Object.assign({}, val) as T;
}

// ─── Knowledge Base (Feature 5) ──────────────────────────────────────────────

export function insertKBEntry(entry: { id: string; title: string; content: string; tags?: string | null; source?: string | null; agent_id?: string | null; project_id?: string | null }): KBEntry {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO knowledge_base (id, title, content, tags, source, agent_id, project_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(entry.id, entry.title, entry.content, entry.tags ?? null, entry.source ?? null, entry.agent_id ?? null, entry.project_id ?? null, now, now);
  // Index in FTS
  const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(entry.id) as { rowid: number } | undefined;
  if (row) {
    db.prepare('INSERT INTO kb_fts(rowid, title, content, kb_id) VALUES (?, ?, ?, ?)').run(row.rowid, entry.title, entry.content, entry.id);
  }
  return getKBEntryById(entry.id)!;
}

export function getKBEntryById(id: string): KBEntry | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM knowledge_base WHERE id = ?').get(id);
  return row ? cast<KBEntry>(row) : null;
}

export function listKBEntries(projectId?: string): KBEntry[] {
  const db = getDb();
  let rows: unknown[];
  if (projectId) {
    rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
  } else {
    rows = db.prepare('SELECT * FROM knowledge_base ORDER BY updated_at DESC').all();
  }
  return rows.map(r => cast<KBEntry>(r));
}

export function searchKB(query: string, projectId?: string, limit = 20): Array<KBEntry & { excerpt: string }> {
  const db = getDb();
  const sql = `
    SELECT kb.*, snippet(kb_fts, 1, '<mark>', '</mark>', '…', 30) as excerpt
    FROM kb_fts f
    JOIN knowledge_base kb ON kb.id = f.kb_id
    WHERE kb_fts MATCH ?
    ${projectId ? 'AND kb.project_id = ?' : ''}
    ORDER BY rank
    LIMIT ?
  `;
  try {
    const args = projectId ? [query, projectId, limit] : [query, limit];
    const rows = db.prepare(sql).all(...args);
    const results = rows.map(r => cast<KBEntry & { excerpt: string }>(r));
    if (results.length > 0) touchKBEntries(results.map(r => r.id));
    return results;
  } catch {
    try {
      const escaped = `"${query.replace(/"/g, '""')}"`;
      const args = projectId ? [escaped, projectId, limit] : [escaped, limit];
      const rows = db.prepare(sql).all(...args);
      const results = rows.map(r => cast<KBEntry & { excerpt: string }>(r));
      if (results.length > 0) touchKBEntries(results.map(r => r.id));
      return results;
    } catch { return []; }
  }
}

export function updateKBEntry(id: string, fields: Partial<Pick<KBEntry, 'title' | 'content' | 'tags'>>): KBEntry | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  // Update FTS
  const entry = getKBEntryById(id);
  if (entry) {
    const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (row) {
      db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
      db.prepare('INSERT INTO kb_fts(rowid, title, content, kb_id) VALUES (?, ?, ?, ?)').run(row.rowid, entry.title, entry.content, entry.id);
    }
  }
  return entry;
}

export function deleteKBEntry(id: string): void {
  const db = getDb();
  const row = db.prepare('SELECT rowid FROM knowledge_base WHERE id = ?').get(id) as { rowid: number } | undefined;
  if (row) {
    db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
  }
  db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(id);
}

/** Update last_hit_at timestamp for entries that were matched/used. */
export function touchKBEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const now = Date.now();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE knowledge_base SET last_hit_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'also', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what', 'which',
  'who', 'when', 'where', 'how', 'why', 'if', 'then', 'else', 'about',
  'up', 'out', 'use', 'using', 'used', 'make', 'made', 'new', 'get',
  'set', 'add', 'run', 'file', 'code', 'task', 'job', 'agent', 'work',
]);

/** Extract keywords from text, skip stopwords, return top N words. */
function extractKeywords(text: string, maxWords = 8): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) { seen.add(w); unique.push(w); }
  }
  return unique.slice(0, maxWords);
}

/**
 * Search KB using keywords extracted from a query string.
 * Builds an OR query from extracted keywords, handles FTS syntax errors with fallback.
 */
export function searchKBForMemory(query: string, projectId: string | null, limit = 10): KBEntry[] {
  const db = getDb();
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];

  // Build FTS5 OR query from keywords
  const ftsQuery = keywords.join(' OR ');

  // Project-scoped entries ranked first via sort_group
  const sql = projectId
    ? `SELECT kb.*, CASE WHEN kb.project_id = ? THEN 0 ELSE 1 END AS sort_group
       FROM kb_fts f
       JOIN knowledge_base kb ON kb.id = f.kb_id
       WHERE kb_fts MATCH ?
         AND (kb.project_id = ? OR kb.project_id IS NULL)
       ORDER BY sort_group ASC, rank
       LIMIT ?`
    : `SELECT kb.*
       FROM kb_fts f
       JOIN knowledge_base kb ON kb.id = f.kb_id
       WHERE kb_fts MATCH ?
         AND kb.project_id IS NULL
       ORDER BY rank
       LIMIT ?`;

  try {
    const args = projectId
      ? [projectId, ftsQuery, projectId, limit]
      : [ftsQuery, limit];
    const rows = db.prepare(sql).all(...args);
    const results = rows.map(r => cast<KBEntry>(r));
    if (results.length > 0) touchKBEntries(results.map(r => r.id));
    return results;
  } catch {
    // FTS syntax error — try as quoted phrase of the first keyword
    try {
      const escaped = `"${keywords[0]}"`;
      const args = projectId
        ? [projectId, escaped, projectId, limit]
        : [escaped, limit];
      const rows = db.prepare(sql).all(...args);
      const results = rows.map(r => cast<KBEntry>(r));
      if (results.length > 0) touchKBEntries(results.map(r => r.id));
      return results;
    } catch { return []; }
  }
}

/**
 * Get relevant KB entries for a job based on its title and description.
 * Uses FTS keyword search for relevance, falls back to recency if FTS returns nothing.
 */
export function getMemoryForJob(projectId: string | null, jobTitle?: string, jobDescription?: string, limit = 10): KBEntry[] {
  // Try relevance-based search first
  const searchText = [jobTitle, jobDescription].filter(Boolean).join(' ');
  if (searchText.trim()) {
    const results = searchKBForMemory(searchText, projectId, limit);
    if (results.length > 0) return results;
  }

  // Fallback: recency-based (original behavior)
  const db = getDb();
  if (projectId) {
    const rows = db.prepare(`
      SELECT *, CASE WHEN project_id = ? THEN 0 ELSE 1 END AS sort_group
      FROM knowledge_base
      WHERE project_id = ? OR project_id IS NULL
      ORDER BY sort_group ASC, updated_at DESC
      LIMIT ?
    `).all(projectId, projectId, limit);
    const results = rows.map(r => cast<KBEntry>(r));
    if (results.length > 0) touchKBEntries(results.map(r => r.id));
    return results;
  }
  const rows = db.prepare(`
    SELECT * FROM knowledge_base
    WHERE project_id IS NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
  const results = rows.map(r => cast<KBEntry>(r));
  if (results.length > 0) touchKBEntries(results.map(r => r.id));
  return results;
}

/** Delete stale KB entries older than maxAge that have never been hit. */
export function pruneStaleKBEntries(maxAgeMs: number): number {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  // Get IDs to delete so we can clean up FTS
  const rows = db.prepare(`
    SELECT id, rowid FROM knowledge_base
    WHERE last_hit_at IS NULL AND created_at < ?
  `).all(cutoff) as Array<{ id: string; rowid: number }>;
  for (const row of rows) {
    db.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid);
    db.prepare('DELETE FROM knowledge_base WHERE id = ?').run(row.id);
  }
  return rows.length;
}

/** List KB entries for a project grouped by FTS similarity for consolidation. */
export function getKBEntriesForProject(projectId: string | null): KBEntry[] {
  const db = getDb();
  if (projectId) {
    const rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    return rows.map(r => cast<KBEntry>(r));
  }
  const rows = db.prepare('SELECT * FROM knowledge_base WHERE project_id IS NULL ORDER BY updated_at DESC').all();
  return rows.map(r => cast<KBEntry>(r));
}

// ─── Reviews (Feature 3) ────────────────────────────────────────────────────

export function insertReview(review: { id: string; parent_job_id: string; model: string; reviewer_job_id?: string | null }): Review {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO reviews (id, parent_job_id, reviewer_job_id, model, verdict, summary, created_at, completed_at)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)
  `).run(review.id, review.parent_job_id, review.reviewer_job_id ?? null, review.model, now);
  return cast<Review>(db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id));
}

export function getReviewsForJob(parentJobId: string): Review[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reviews WHERE parent_job_id = ? ORDER BY created_at ASC').all(parentJobId);
  return rows.map(r => cast<Review>(r));
}

export function updateReview(id: string, fields: Partial<Pick<Review, 'reviewer_job_id' | 'verdict' | 'summary' | 'completed_at'>>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE reviews SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getReviewByReviewerJob(reviewerJobId: string): Review | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM reviews WHERE reviewer_job_id = ?').get(reviewerJobId);
  return row ? cast<Review>(row) : null;
}

export function updateJobReviewStatus(id: string, reviewStatus: ReviewStatus | null): void {
  const db = getDb();
  db.prepare('UPDATE jobs SET review_status = ?, updated_at = ? WHERE id = ?').run(reviewStatus, Date.now(), id);
}

// ─── Template Model Stats (Feature 2) ────────────────────────────────────────

export function getTemplateModelStats(): TemplateModelStat[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT j.template_id, t.name as template_name, j.model,
      COUNT(*) as total,
      SUM(CASE WHEN j.status='done' THEN 1 ELSE 0 END) as succeeded,
      CAST(SUM(CASE WHEN j.status='done' THEN 1 ELSE 0 END) AS REAL) /
        NULLIF(COUNT(*), 0) as success_rate,
      AVG(a.cost_usd) as avg_cost,
      AVG(a.duration_ms) as avg_duration_ms,
      AVG(a.num_turns) as avg_turns
    FROM jobs j
    LEFT JOIN templates t ON t.id = j.template_id
    LEFT JOIN agents a ON a.job_id = j.id AND a.status IN ('done','failed')
    WHERE j.status IN ('done','failed') AND j.debate_id IS NULL AND j.original_job_id IS NULL AND j.review_parent_job_id IS NULL
    GROUP BY j.template_id, j.model HAVING total >= 1
  `).all();
  return rows.map(r => cast<TemplateModelStat>(r));
}

// ─── Budget ───────────────────────────────────────────────────────────────────

export function getTodaySpendUsd(): number {
  const db = getDb();
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM agents WHERE started_at >= ? AND cost_usd IS NOT NULL').get(startOfDay) as { total: number };
  return row.total;
}

// ─── Discussions ──────────────────────────────────────────────────────────────

export function insertDiscussion(disc: { id: string; agent_id: string; topic: string; category: DiscussionCategory; priority: DiscussionPriority; context?: string | null }): Discussion {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO discussions (id, agent_id, topic, category, priority, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?, ?)').run(disc.id, disc.agent_id, disc.topic, disc.category, disc.priority, disc.context ?? null, now, now);
  return getDiscussionById(disc.id)!;
}

export function getDiscussionById(id: string): Discussion | null {
  const row = getDb().prepare(`
    SELECT d.*,
      CASE WHEN d.status = 'open' AND (
        (SELECT role FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        AND (SELECT requires_reply FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 1
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM discussions d WHERE d.id = ?
  `).get(id) as DbRow | undefined;
  if (!row) return null;
  const d = cast<Discussion>(row); d.needs_reply = !!row.needs_reply; return d;
}

export function listDiscussions(status?: DiscussionStatus): Discussion[] {
  const db = getDb();
  const sql = `
    SELECT d.*,
      CASE WHEN d.status = 'open' AND (
        (SELECT role FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        AND (SELECT requires_reply FROM discussion_messages WHERE discussion_id = d.id ORDER BY created_at DESC LIMIT 1) = 1
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM discussions d
    ${status ? 'WHERE d.status = ?' : ''}
    ORDER BY d.updated_at DESC
  `;
  const rows = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  return rows.map((r: DbRow) => { const d = cast<Discussion>(r); d.needs_reply = !!r.needs_reply; return d; });
}

export function updateDiscussion(id: string, updates: Partial<Pick<Discussion, 'status' | 'topic' | 'priority'>>): void {
  const sets: string[] = ['updated_at = ?']; const vals: (string | number | null)[] = [Date.now()];
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.topic !== undefined) { sets.push('topic = ?'); vals.push(updates.topic); }
  if (updates.priority !== undefined) { sets.push('priority = ?'); vals.push(updates.priority); }
  vals.push(id);
  getDb().prepare(`UPDATE discussions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertDiscussionMessage(msg: { id: string; discussion_id: string; role: 'eye' | 'user'; content: string; requires_reply?: boolean }): DiscussionMessage {
  const db = getDb(); const now = Date.now();
  const requiresReply = msg.requires_reply !== false ? 1 : 0;
  db.prepare('INSERT INTO discussion_messages (id, discussion_id, role, content, requires_reply, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(msg.id, msg.discussion_id, msg.role, msg.content, requiresReply, now);
  db.prepare('UPDATE discussions SET updated_at = ? WHERE id = ?').run(now, msg.discussion_id);
  const dm = cast<DiscussionMessage>(db.prepare('SELECT * FROM discussion_messages WHERE id = ?').get(msg.id)!);
  dm.requires_reply = !!dm.requires_reply;
  return dm;
}

export function getDiscussionMessages(discussionId: string): DiscussionMessage[] {
  return getDb().prepare('SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC').all(discussionId).map(r => {
    const m = cast<DiscussionMessage>(r); m.requires_reply = !!m.requires_reply; return m;
  });
}

export function getDiscussionsWithNewUserReplies(_agentId: string): Discussion[] {
  // Return open discussions where:
  // (a) the last message is from the user (new unread reply), OR
  // (b) the user has replied within the last 24h and Eye acknowledged but hasn't resolved
  //     (Eye said "I'll look into it" but then the discussion was left open)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return getDb().prepare(`
    SELECT d.* FROM discussions d
    WHERE d.status = 'open'
      AND EXISTS (
        SELECT 1 FROM discussion_messages dm
        WHERE dm.discussion_id = d.id
          AND dm.role = 'user'
          AND dm.created_at > ?
      )
    ORDER BY d.updated_at DESC
  `).all(cutoff).map(r => cast<Discussion>(r));
}

// ─── Proposals ────────────────────────────────────────────────────────────────

export function insertProposal(prop: { id: string; agent_id: string; title: string; summary: string; rationale: string; confidence: number; estimated_complexity: ProposalComplexity; category: ProposalCategory; evidence?: string | null; implementation_plan?: string | null; codex_confirmed?: boolean | null; codex_confidence?: number | null; codex_reasoning?: string | null }): Proposal {
  const db = getDb(); const now = Date.now();
  const codexConfirmedVal = prop.codex_confirmed == null ? null : (prop.codex_confirmed ? 1 : 0);
  db.prepare('INSERT INTO proposals (id, agent_id, title, summary, rationale, confidence, estimated_complexity, category, evidence, implementation_plan, status, execution_job_id, codex_confirmed, codex_confidence, codex_reasoning, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', NULL, ?, ?, ?, ?, ?)').run(prop.id, prop.agent_id, prop.title, prop.summary, prop.rationale, prop.confidence, prop.estimated_complexity, prop.category, prop.evidence ?? null, prop.implementation_plan ?? null, codexConfirmedVal, prop.codex_confidence ?? null, prop.codex_reasoning ?? null, now, now);
  return getProposalById(prop.id)!;
}

export function getProposalById(id: string): Proposal | null {
  const row = getDb().prepare(`
    SELECT p.*,
      CASE
        WHEN p.status IN ('pending', 'failed') THEN 1
        WHEN p.status = 'discussing' AND (
          NOT EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p.id)
          OR (SELECT role FROM proposal_messages WHERE proposal_id = p.id ORDER BY created_at DESC LIMIT 1) = 'eye'
        ) THEN 1
        ELSE 0
      END AS needs_reply
    FROM proposals p WHERE p.id = ?
  `).get(id) as DbRow | undefined;
  if (!row) return null;
  const p = cast<Proposal>(row); p.needs_reply = !!row.needs_reply; return p;
}

export function listProposals(status?: ProposalStatus): Proposal[] {
  const db = getDb();
  const needsReplySql = `
    CASE
      WHEN p.status IN ('pending', 'failed') THEN 1
      WHEN p.status = 'discussing' AND (
        NOT EXISTS (SELECT 1 FROM proposal_messages WHERE proposal_id = p.id)
        OR (SELECT role FROM proposal_messages WHERE proposal_id = p.id ORDER BY created_at DESC LIMIT 1) = 'eye'
      ) THEN 1
      ELSE 0
    END AS needs_reply
  `;
  if (status) {
    const rows = db.prepare(`SELECT p.*, ${needsReplySql} FROM proposals p WHERE p.status = ? ORDER BY p.confidence DESC, p.updated_at DESC`).all(status);
    return rows.map((r: DbRow) => { const p = cast<Proposal>(r); p.needs_reply = !!r.needs_reply; return p; });
  }
  const rows = db.prepare(`SELECT p.*, ${needsReplySql} FROM proposals p ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'discussing' THEN 1 WHEN 'approved' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'failed' THEN 4 WHEN 'done' THEN 5 WHEN 'rejected' THEN 6 END, p.confidence DESC, p.updated_at DESC`).all();
  return rows.map((r: DbRow) => { const p = cast<Proposal>(r); p.needs_reply = !!r.needs_reply; return p; });
}

export function updateProposal(id: string, updates: Partial<Pick<Proposal, 'status' | 'execution_job_id' | 'title' | 'summary' | 'rationale' | 'implementation_plan'>>): void {
  const sets: string[] = ['updated_at = ?']; const vals: (string | number | null)[] = [Date.now()];
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.execution_job_id !== undefined) { sets.push('execution_job_id = ?'); vals.push(updates.execution_job_id); }
  if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
  if (updates.summary !== undefined) { sets.push('summary = ?'); vals.push(updates.summary); }
  if (updates.rationale !== undefined) { sets.push('rationale = ?'); vals.push(updates.rationale); }
  if (updates.implementation_plan !== undefined) { sets.push('implementation_plan = ?'); vals.push(updates.implementation_plan); }
  vals.push(id);
  getDb().prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertProposalMessage(msg: { id: string; proposal_id: string; role: 'eye' | 'user'; content: string }): ProposalMessage {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO proposal_messages (id, proposal_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(msg.id, msg.proposal_id, msg.role, msg.content, now);
  const proposal = getProposalById(msg.proposal_id);
  if (proposal && msg.role === 'user' && proposal.status === 'pending') {
    db.prepare("UPDATE proposals SET status = 'discussing', updated_at = ? WHERE id = ?").run(now, msg.proposal_id);
  } else {
    db.prepare('UPDATE proposals SET updated_at = ? WHERE id = ?').run(now, msg.proposal_id);
  }
  return cast<ProposalMessage>(db.prepare('SELECT * FROM proposal_messages WHERE id = ?').get(msg.id)!);
}

export function getProposalMessages(proposalId: string): ProposalMessage[] {
  return getDb().prepare('SELECT * FROM proposal_messages WHERE proposal_id = ? ORDER BY created_at ASC').all(proposalId).map(r => cast<ProposalMessage>(r));
}

export function getProposalsWithNewUserReplies(agentId: string): Proposal[] {
  return getDb().prepare(`SELECT p.* FROM proposals p WHERE p.status IN ('pending', 'discussing') AND p.agent_id = ? AND EXISTS (SELECT 1 FROM proposal_messages pm WHERE pm.proposal_id = p.id AND pm.role = 'user' AND pm.created_at = (SELECT MAX(created_at) FROM proposal_messages WHERE proposal_id = p.id)) ORDER BY p.updated_at DESC`).all(agentId).map(r => cast<Proposal>(r));
}

// ─── PR Reviews ───────────────────────────────────────────────────────────────

export function insertPrReview(review: {
  id: string; pr_number: number; pr_url: string; pr_title: string;
  pr_author: string | null; repo: string; summary: string;
  comments: string; status?: string; github_review_id?: string | null;
}): PrReview {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO pr_reviews (id, pr_number, pr_url, pr_title, pr_author, repo, summary, comments, status, github_review_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(review.id, review.pr_number, review.pr_url, review.pr_title, review.pr_author, review.repo, review.summary, review.comments, review.status ?? 'draft', review.github_review_id ?? null, now, now);
  return getPrReviewById(review.id)!;
}

export function listPrReviews(): PrReview[] {
  const rows = getDb().prepare(`
    SELECT pr.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM pr_review_messages m
        WHERE m.review_id = pr.id AND m.role = 'user'
          AND m.created_at = (SELECT MAX(created_at) FROM pr_review_messages WHERE review_id = pr.id)
      ) THEN 1 ELSE 0 END AS needs_reply
    FROM pr_reviews pr WHERE pr.status != 'dismissed' ORDER BY pr.created_at DESC
  `).all();
  return rows.map((r: DbRow) => { const p = cast<PrReview>(r); p.needs_reply = !!r.needs_reply; return p; });
}

export function getPrReviewById(id: string): PrReview | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id) as DbRow | undefined;
  return row ? cast<PrReview>(row) : null;
}

export function getPrReviewByPrNumber(prNumber: number, repo: string): PrReview | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE pr_number = ? AND repo = ? ORDER BY created_at DESC LIMIT 1').get(prNumber, repo) as DbRow | undefined;
  return row ? cast<PrReview>(row) : null;
}

export function updatePrReview(id: string, updates: Partial<{ summary: string; comments: string; status: string; github_review_id: string | null }>): void {
  const sets: string[] = ['updated_at = ?']; const vals: (string | number | null)[] = [Date.now()];
  if (updates.summary !== undefined) { sets.push('summary = ?'); vals.push(updates.summary); }
  if (updates.comments !== undefined) { sets.push('comments = ?'); vals.push(updates.comments); }
  if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status); }
  if (updates.github_review_id !== undefined) { sets.push('github_review_id = ?'); vals.push(updates.github_review_id); }
  vals.push(id);
  getDb().prepare(`UPDATE pr_reviews SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function insertPrReviewMessage(msg: { id: string; review_id: string; role: 'eye' | 'user'; content: string }): PrReviewMessage {
  const db = getDb(); const now = Date.now();
  db.prepare('INSERT INTO pr_review_messages (id, review_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(msg.id, msg.review_id, msg.role, msg.content, now);
  db.prepare('UPDATE pr_reviews SET updated_at = ? WHERE id = ?').run(now, msg.review_id);
  return cast<PrReviewMessage>(db.prepare('SELECT * FROM pr_review_messages WHERE id = ?').get(msg.id)!);
}

export function getPrReviewMessages(reviewId: string): PrReviewMessage[] {
  return getDb().prepare('SELECT * FROM pr_review_messages WHERE review_id = ? ORDER BY created_at ASC').all(reviewId).map(r => cast<PrReviewMessage>(r));
}

export function getPrReviewsWithNewUserReplies(): PrReview[] {
  return getDb().prepare(`
    SELECT pr.* FROM pr_reviews pr WHERE pr.status = 'draft' AND EXISTS (
      SELECT 1 FROM pr_review_messages m WHERE m.review_id = pr.id AND m.role = 'user'
        AND m.created_at = (SELECT MAX(created_at) FROM pr_review_messages WHERE review_id = pr.id)
    ) ORDER BY pr.updated_at DESC
  `).all().map(r => cast<PrReview>(r));
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export function insertWorkflow(workflow: Workflow): Workflow {
  const db = getDb();
  db.prepare(`
    INSERT INTO workflows (id, title, task, work_dir, implementer_model, reviewer_model, max_cycles, current_cycle, current_phase, status, milestones_total, milestones_done, project_id, max_turns_assess, max_turns_review, max_turns_implement, stop_mode_assess, stop_value_assess, stop_mode_review, stop_value_review, stop_mode_implement, stop_value_implement, template_id, use_worktree, worktree_path, worktree_branch, blocked_reason, pr_url, completion_threshold, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workflow.id, workflow.title, workflow.task, workflow.work_dir,
    workflow.implementer_model, workflow.reviewer_model,
    workflow.max_cycles, workflow.current_cycle, workflow.current_phase, workflow.status,
    workflow.milestones_total, workflow.milestones_done,
    workflow.project_id,
    workflow.max_turns_assess, workflow.max_turns_review, workflow.max_turns_implement,
    workflow.stop_mode_assess, workflow.stop_value_assess ?? null,
    workflow.stop_mode_review, workflow.stop_value_review ?? null,
    workflow.stop_mode_implement, workflow.stop_value_implement ?? null,
    workflow.template_id, workflow.use_worktree,
    workflow.worktree_path ?? null, workflow.worktree_branch ?? null,
    workflow.blocked_reason ?? null, workflow.pr_url ?? null,
    workflow.completion_threshold ?? 1.0,
    workflow.created_at, workflow.updated_at
  );
  return getWorkflowById(workflow.id)!;
}

export function getWorkflowById(id: string): Workflow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  return row ? cast<Workflow>(row) : null;
}

export function listWorkflows(): Workflow[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all();
  return rows.map(r => cast<Workflow>(r));
}

export function updateWorkflow(id: string, fields: Partial<Pick<Workflow, 'current_cycle' | 'current_phase' | 'status' | 'milestones_total' | 'milestones_done' | 'worktree_path' | 'worktree_branch' | 'blocked_reason' | 'pr_url' | 'stop_mode_assess' | 'stop_value_assess' | 'stop_mode_review' | 'stop_value_review' | 'stop_mode_implement' | 'stop_value_implement'>>): Workflow | null {
  const db = getDb();
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getWorkflowById(id);
}

export function getJobsForWorkflow(workflowId: string): Job[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM jobs WHERE workflow_id = ? ORDER BY workflow_cycle ASC, created_at ASC').all(workflowId);
  return rows.map(r => cast<Job>(r));
}

/**
 * Get the diff from the most recent completed implement-phase agent for a workflow.
 * Used to inject recent-change context into review prompts.
 */
export function getLastImplementDiff(workflowId: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT a.diff FROM agents a
    JOIN jobs j ON a.job_id = j.id
    WHERE j.workflow_id = ? AND j.workflow_phase = 'implement' AND j.status = 'done' AND a.diff IS NOT NULL
    ORDER BY j.workflow_cycle DESC, a.finished_at DESC
    LIMIT 1
  `).get(workflowId) as { diff: string } | undefined;
  return row?.diff ?? null;
}

/**
 * Compute latency metrics for a workflow by joining jobs and agents.
 * Returns per-phase timing plus aggregated summary.
 */
export function getWorkflowMetrics(workflowId: string): import('../../shared/types.js').WorkflowMetrics | null {
  const workflow = getWorkflowById(workflowId);
  if (!workflow) return null;

  const db = getDb();
  // Get all workflow phase jobs with their agent timing, ordered by cycle + creation
  const rows = db.prepare(`
    SELECT
      j.id AS job_id,
      j.workflow_cycle AS cycle,
      j.workflow_phase AS phase,
      j.created_at AS job_created_at,
      a.started_at AS agent_started_at,
      a.finished_at AS agent_finished_at,
      a.cost_usd AS agent_cost_usd
    FROM jobs j
    LEFT JOIN agents a ON a.job_id = j.id
    WHERE j.workflow_id = ?
    ORDER BY j.workflow_cycle ASC, j.created_at ASC
  `).all(workflowId) as Array<{
    job_id: string;
    cycle: number;
    phase: string;
    job_created_at: number;
    agent_started_at: number | null;
    agent_finished_at: number | null;
    agent_cost_usd: number | null;
  }>;

  const phases: import('../../shared/types.js').WorkflowPhaseMetric[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const queueWait = r.agent_started_at != null ? r.agent_started_at - r.job_created_at : null;
    const agentDuration = (r.agent_started_at != null && r.agent_finished_at != null)
      ? r.agent_finished_at - r.agent_started_at : null;
    // Handoff = next phase's job_created_at - this agent's finished_at
    const next = rows[i + 1];
    const handoff = (r.agent_finished_at != null && next)
      ? next.job_created_at - r.agent_finished_at : null;

    phases.push({
      cycle: r.cycle,
      phase: r.phase,
      job_id: r.job_id,
      job_created_at: r.job_created_at,
      agent_started_at: r.agent_started_at,
      agent_finished_at: r.agent_finished_at,
      agent_cost_usd: r.agent_cost_usd,
      queue_wait_ms: queueWait,
      agent_duration_ms: agentDuration,
      handoff_ms: handoff,
    });
  }

  // Summary
  const queueWaits = phases.map(p => p.queue_wait_ms).filter((v): v is number => v != null);
  const handoffs = phases.map(p => p.handoff_ms).filter((v): v is number => v != null);
  const agentDurations = phases.map(p => p.agent_duration_ms).filter((v): v is number => v != null);
  const costs = phases.map(p => p.agent_cost_usd).filter((v): v is number => v != null);

  const firstCreated = phases.length > 0 ? phases[0].job_created_at : workflow.created_at;
  const lastFinished = phases.length > 0
    ? phases.reduce((max, p) => {
        const t = p.agent_finished_at ?? 0;
        return t > max ? t : max;
      }, 0)
    : 0;
  const now = Date.now();
  const endTime = (workflow.status === 'running' || workflow.status === 'blocked') ? now : (lastFinished || now);

  return {
    workflow_id: workflowId,
    phases,
    summary: {
      total_wall_clock_ms: endTime - firstCreated,
      total_agent_ms: agentDurations.reduce((s, v) => s + v, 0),
      total_queue_wait_ms: queueWaits.reduce((s, v) => s + v, 0),
      total_handoff_ms: handoffs.reduce((s, v) => s + v, 0),
      avg_queue_wait_ms: queueWaits.length > 0 ? Math.round(queueWaits.reduce((s, v) => s + v, 0) / queueWaits.length) : null,
      avg_handoff_ms: handoffs.length > 0 ? Math.round(handoffs.reduce((s, v) => s + v, 0) / handoffs.length) : null,
      total_cost_usd: costs.reduce((s, v) => s + v, 0),
      phase_count: phases.length,
    },
  };
}

// ─── Resilience Events ──────────────────────────────────────────────────────

export interface ResilienceEvent {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  details: string | null;
  created_at: number;
}

export function insertResilienceEvent(event: {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  details?: string | null;
  created_at: number;
}): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO resilience_events (id, event_type, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(event.id, event.event_type, event.entity_type, event.entity_id, event.details ?? null, event.created_at);
}

export function listResilienceEvents(opts?: { type?: string; limit?: number }): ResilienceEvent[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  if (opts?.type) {
    return db.prepare(
      'SELECT * FROM resilience_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.type, limit).map(r => cast<ResilienceEvent>(r));
  }
  return db.prepare(
    'SELECT * FROM resilience_events ORDER BY created_at DESC LIMIT ?'
  ).all(limit).map(r => cast<ResilienceEvent>(r));
}

/** Check if any non-terminal job has work_dir set to the given path. */
export function isWorkDirInUse(dirPath: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM jobs WHERE work_dir = ? AND status NOT IN ('done', 'failed', 'cancelled') LIMIT 1"
  ).get(dirPath);
  return !!row;
}

// ─── Workflow File Claims (M13/6B) ──────────────────────────────────────────

export interface FileClaim {
  id: string;
  workflow_id: string;
  file_path: string;
  claimed_at: number;
  released_at: number | null;
}

/** Claim files for a workflow. Returns any conflicting active claims from other workflows. */
export function claimFiles(workflowId: string, filePaths: string[]): FileClaim[] {
  const db = getDb();
  const now = Date.now();
  const conflicts: FileClaim[] = [];

  for (const fp of filePaths) {
    // Check for active claims from other workflows
    const existing = db.prepare(
      'SELECT * FROM workflow_file_claims WHERE file_path = ? AND workflow_id != ? AND released_at IS NULL'
    ).get(fp, workflowId);
    if (existing) {
      conflicts.push(cast<FileClaim>(existing));
    }
    // Upsert our claim (idempotent — skip if already claimed by this workflow)
    const alreadyClaimed = db.prepare(
      'SELECT 1 FROM workflow_file_claims WHERE file_path = ? AND workflow_id = ? AND released_at IS NULL'
    ).get(fp, workflowId);
    if (!alreadyClaimed) {
      db.prepare(
        'INSERT INTO workflow_file_claims (id, workflow_id, file_path, claimed_at) VALUES (?, ?, ?, ?)'
      ).run(randomUUID(), workflowId, fp, now);
    }
  }
  return conflicts;
}

/** Release all active claims for a workflow. */
export function releaseWorkflowClaims(workflowId: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE workflow_file_claims SET released_at = ? WHERE workflow_id = ? AND released_at IS NULL'
  ).run(Date.now(), workflowId);
}

/** Get all active claims for a workflow. */
export function getActiveClaimsForWorkflow(workflowId: string): FileClaim[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM workflow_file_claims WHERE workflow_id = ? AND released_at IS NULL'
  ).all(workflowId).map(r => cast<FileClaim>(r));
}
