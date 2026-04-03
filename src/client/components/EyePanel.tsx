import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DiscussionThread } from './DiscussionThread';
import { ProposalCard } from './ProposalCard';
import socket from '../socket';
import type { Discussion, DiscussionMessage, Proposal, ProposalMessage, AgentWithJob } from '@shared/types';

interface EyeStatus {
  running: boolean;
  active: boolean;
  scheduledAt: number | null;
  jobId: string | null;
  cycleCount: number;
  failed?: boolean;
}

interface EyePanelProps {
  discussions: Discussion[];
  proposals: Proposal[];
  onClose: () => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  question: '?',
  observation: 'i',
  alert: '!',
};

const CATEGORY_COLORS: Record<string, string> = {
  question: '#f59e0b',
  observation: '#58a6ff',
  alert: '#f85149',
};

const PRIORITY_WEIGHT: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// ─── Inline Output (same pattern as DebateDetailModal) ───────────────────────

const SUMMARY_LIMIT = 500;

function InlineOutput({ agentId, jobStatus }: { agentId: string; jobStatus: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch(`/api/agents/${agentId}/result-text`)
      .then(r => r.ok ? r.json() : { text: null })
      .then((data: { text: string | null }) => setText(data.text))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)' }}>Loading...</div>;
  if (!text) {
    const msg = jobStatus === 'done' || jobStatus === 'failed' ? 'No summary available.' : 'Agent is still working...';
    return <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>{msg}</div>;
  }

  const truncated = !expanded && text.length > SUMMARY_LIMIT;
  const display = truncated ? text.slice(0, SUMMARY_LIMIT).replace(/\s+\S*$/, '') + '…' : text;

  return (
    <div style={{
      padding: '10px 14px', fontSize: 12, lineHeight: 1.65,
      color: 'var(--text-primary)', background: 'var(--bg-surface)',
      borderTop: '1px solid var(--border)',
    }}>
      <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{display}</div>
      {text.length > SUMMARY_LIMIT && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            marginTop: 6, background: 'none', border: 'none', padding: 0,
            fontSize: 11, color: 'var(--accent)', cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : 'Show full output'}
        </button>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'done' ? 'var(--status-done)' :
    status === 'failed' ? 'var(--status-failed)' :
    status === 'cancelled' ? 'var(--status-failed)' :
    status === 'running' || status === 'assigned' ? 'var(--status-running)' :
    'var(--text-dim)';
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, marginRight: 6, flexShrink: 0 }} />;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatNextCycle(scheduledAt: number): string {
  const diffMs = scheduledAt - Date.now();
  if (diffMs <= 0) return 'soon';
  if (diffMs < 60_000) return `in ${Math.round(diffMs / 1000)}s`;
  return `in ${Math.round(diffMs / 60_000)}m`;
}

// ─── Send to Eye ──────────────────────────────────────────────────────────────

function SendToEye({ onCreated }: { onCreated?: (discussionId: string) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/eye/discussions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setText('');
        onCreated?.(data.discussion.id);
      }
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'flex-end' }}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Send a message to Eye..."
        disabled={sending}
        rows={1}
        style={{
          flex: 1, background: 'var(--bg-surface)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 10px', color: 'var(--text-primary)', fontSize: 12,
          resize: 'none', overflow: 'hidden', fontFamily: 'inherit', lineHeight: 1.4,
        }}
      />
      <button className="btn btn-sm btn-primary" onClick={handleSend} disabled={sending || !text.trim()}>
        {sending ? '...' : 'Send'}
      </button>
    </div>
  );
}

// ─── Activity Tab ─────────────────────────────────────────────────────────────

function ActivityTab() {
  const [agents, setAgents] = useState<AgentWithJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/agents');
      if (res.ok) setAgents(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);
  // Refresh every 15s
  useEffect(() => {
    const id = setInterval(fetchAgents, 15_000);
    return () => clearInterval(id);
  }, [fetchAgents]);

  const visibleAgents = agents.filter(a => a.status !== 'failed' && a.status !== 'cancelled');

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (visibleAgents.length === 0) return <div className="eye-empty">No Eye activity yet. Start Eye to begin.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {visibleAgents.map(agent => {
        const isExpanded = expandedId === agent.id;
        const canExpand = ['done', 'failed', 'running', 'cancelled'].includes(agent.status);
        const cost = agent.cost_usd != null ? `$${agent.cost_usd.toFixed(2)}` : null;
        const duration = agent.duration_ms != null ? formatDuration(agent.duration_ms) : null;

        return (
          <div key={agent.id} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                cursor: canExpand ? 'pointer' : 'default',
                background: isExpanded ? 'var(--bg-elevated)' : 'transparent',
              }}
              onClick={() => canExpand && setExpandedId(isExpanded ? null : agent.id)}
              onMouseEnter={e => { if (canExpand && !isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-interactive)'; }}
              onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              <StatusDot status={agent.status} />
              <span style={{ fontSize: 12, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {agent.job.title}
              </span>
              {agent.status_message && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.status_message}
                </span>
              )}
              {cost && <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{cost}</span>}
              {duration && <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{duration}</span>}
              <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0 }}>{formatTime(agent.started_at)}</span>
              {canExpand && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{isExpanded ? '\u25b4' : '\u25be'}</span>}
            </div>
            {isExpanded && <InlineOutput agentId={agent.id} jobStatus={agent.status} />}
          </div>
        );
      })}
    </div>
  );
}

// ─── Summary Tab ──────────────────────────────────────────────────────────────

interface DailySummaryItem { timestamp: number; text: string }
interface DailySummary { date: string; items: DailySummaryItem[] }

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (dateStr === today) return 'Today';
  if (dateStr === yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function SummaryTab() {
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  const fetchSummaries = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/summaries');
      if (res.ok) {
        const data: DailySummary[] = await res.json();
        setSummaries(data);
        // Auto-expand today's date
        const today = new Date().toISOString().slice(0, 10);
        setExpandedDates(prev => {
          const next = new Set(prev);
          if (data.some(s => s.date === today)) next.add(today);
          return next;
        });
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSummaries(); }, [fetchSummaries]);
  useEffect(() => {
    const id = setInterval(fetchSummaries, 30_000);
    return () => clearInterval(id);
  }, [fetchSummaries]);

  const toggleDate = (date: string) => setExpandedDates(prev => {
    const next = new Set(prev);
    if (next.has(date)) next.delete(date); else next.add(date);
    return next;
  });

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (summaries.length === 0) return (
    <div className="eye-empty" style={{ padding: 24 }}>
      No summary yet. Eye will populate this as it works.<br />
      <span style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6, display: 'block' }}>
        Eye uses <code>update_daily_summary</code> to record key findings each cycle.
      </span>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {summaries.map(summary => {
        const isExpanded = expandedDates.has(summary.date);
        return (
          <div key={summary.date} style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                cursor: 'pointer', background: isExpanded ? 'var(--bg-elevated)' : 'transparent',
                userSelect: 'none',
              }}
              onClick={() => toggleDate(summary.date)}
              onMouseEnter={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-interactive)'; }}
              onMouseLeave={e => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
                {formatDate(summary.date)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{summary.items.length} item{summary.items.length !== 1 ? 's' : ''}</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{isExpanded ? '▴' : '▾'}</span>
            </div>
            {isExpanded && (
              <div style={{ padding: '6px 14px 10px', borderTop: '1px solid var(--border)' }}>
                {summary.items.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>No items.</div>
                ) : (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {summary.items.map((item, idx) => (
                      <li key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 11, color: 'var(--text-dim)', flexShrink: 0, paddingTop: 1 }}>
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>{item.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Configure Tab ────────────────────────────────────────────────────────────

interface EyeTarget {
  path: string;
  context: string;
}

const INTERVAL_OPTIONS = [
  { label: '1 minute', ms: 60_000 },
  { label: '5 minutes', ms: 300_000 },
  { label: '10 minutes', ms: 600_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '30 minutes', ms: 1_800_000 },
  { label: '1 hour', ms: 3_600_000 },
  { label: '2 hours', ms: 7_200_000 },
  { label: '4 hours', ms: 14_400_000 },
];

function ConfigureTab() {
  const [targets, setTargets] = useState<EyeTarget[]>([]);
  const [linearApiKey, setLinearApiKey] = useState('');
  const [linearConfigured, setLinearConfigured] = useState(false);
  const [scriptsPath, setScriptsPath] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const [defaultPrompt, setDefaultPrompt] = useState('');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [repeatIntervalMs, setRepeatIntervalMs] = useState(300_000);
  const [addendum, setAddendum] = useState('');
  const [addendumExpanded, setAddendumExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    fetch('/api/eye/config')
      .then(r => r.json())
      .then(data => {
        setTargets(data.targets ?? []);
        setLinearConfigured(!!(data.linearApiKey));
        setScriptsPath(data.scriptsPath ?? '');
        setRepoPath(data.repoPath ?? '');
        setPrompt(data.prompt ?? '');
        setDefaultPrompt(data.defaultPrompt ?? '');
        setRepeatIntervalMs(data.repeatIntervalMs ?? 300_000);
        setAddendum(data.addendum ?? '');
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = () => {
    setTargets(prev => [...prev, { path: '', context: '' }]);
    setDirty(true);
  };

  const handleRemove = (idx: number) => {
    setTargets(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const handleChange = (idx: number, field: 'path' | 'context', value: string) => {
    setTargets(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = { targets, scriptsPath, repoPath, prompt, repeatIntervalMs, addendum };
      if (linearApiKey) body.linearApiKey = linearApiKey;
      const res = await fetch('/api/eye/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setTargets(data.targets);
        setLinearConfigured(!!(data.linearApiKey));
        setLinearApiKey('');
        setScriptsPath(data.scriptsPath ?? '');
        setRepoPath(data.repoPath ?? '');
        setPrompt(data.prompt ?? '');
        setDefaultPrompt(data.defaultPrompt ?? '');
        setRepeatIntervalMs(data.repeatIntervalMs ?? 300_000);
        setAddendum(data.addendum ?? '');
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetPrompt = () => {
    setPrompt('');
    setDirty(true);
  };

  if (loading) return <div className="eye-empty">Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {dirty && (
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)', padding: '8px 16px', display: 'flex', gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      )}
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Target Directories</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Directories for Eye to investigate. Add context to guide its focus.
            </div>
          </div>
          <button className="btn btn-sm" onClick={handleAdd}>+ Add Target</button>
        </div>

        {targets.length === 0 && (
          <div className="eye-empty" style={{ padding: 24 }}>
            No targets configured. Add directories for Eye to investigate.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {targets.map((t, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg-surface)' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <input
                  type="text"
                  value={t.path}
                  onChange={e => handleChange(i, 'path', e.target.value)}
                  placeholder="/path/to/directory"
                  style={{
                    flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border)',
                    borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
                    fontSize: 13, fontFamily: 'var(--font-mono)',
                  }}
                />
                <button
                  className="btn-icon"
                  onClick={() => handleRemove(i)}
                  title="Remove target"
                  style={{ color: 'var(--text-muted)', fontSize: 16 }}
                >
                  &times;
                </button>
              </div>
              <textarea
                value={t.context}
                onChange={e => handleChange(i, 'context', e.target.value)}
                placeholder="Context: what to look for, known issues, tech stack, priorities..."
                rows={2}
                style={{
                  width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
                  fontSize: 12, resize: 'vertical', fontFamily: 'inherit',
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Cycle Frequency */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Cycle Frequency</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          How often Eye runs between cycles. Takes effect immediately if Eye is running.
        </div>
        <select
          value={repeatIntervalMs}
          onChange={e => { setRepeatIntervalMs(Number(e.target.value)); setDirty(true); }}
          style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
            fontSize: 13, cursor: 'pointer',
          }}
        >
          {INTERVAL_OPTIONS.map(opt => (
            <option key={opt.ms} value={opt.ms}>{opt.label}</option>
          ))}
          {!INTERVAL_OPTIONS.some(o => o.ms === repeatIntervalMs) && (
            <option value={repeatIntervalMs}>{Math.round(repeatIntervalMs / 60_000)}m (custom)</option>
          )}
        </select>
      </div>

      {/* Prompt */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>System Prompt</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              The instructions Eye follows each cycle. Leave blank to use the default.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {prompt && (
              <button className="btn btn-sm" onClick={handleResetPrompt} title="Revert to default prompt">
                Reset to default
              </button>
            )}
            <button className="btn btn-sm" onClick={() => setPromptExpanded(e => !e)}>
              {promptExpanded ? 'Collapse' : (prompt ? 'Edit' : 'Customize')}
            </button>
          </div>
        </div>
        {promptExpanded && (
          <textarea
            value={prompt || defaultPrompt}
            onChange={e => { setPrompt(e.target.value === defaultPrompt ? '' : e.target.value); setDirty(true); }}
            rows={20}
            style={{
              width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '8px 10px', color: 'var(--text-primary)',
              fontSize: 12, resize: 'vertical', fontFamily: 'var(--font-mono)',
              lineHeight: 1.5,
            }}
          />
        )}
        {!promptExpanded && prompt && (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-surface)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
            fontStyle: 'italic',
          }}>
            Custom prompt active ({prompt.length} chars)
          </div>
        )}
      </div>

      {/* Addendum */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Addendum</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Eye's accumulated notes — appended to each cycle's prompt. Eye updates this automatically; you can also edit it directly.
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => setAddendumExpanded(e => !e)}>
            {addendumExpanded ? 'Collapse' : (addendum ? 'Edit' : 'View')}
          </button>
        </div>
        {addendumExpanded ? (
          <textarea
            value={addendum}
            onChange={e => { setAddendum(e.target.value); setDirty(true); }}
            rows={20}
            style={{
              width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '8px 10px', color: 'var(--text-primary)',
              fontSize: 12, resize: 'vertical', fontFamily: 'var(--font-mono)',
              lineHeight: 1.5,
            }}
          />
        ) : addendum ? (
          <div style={{
            fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-surface)',
            border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px',
            fontStyle: 'italic',
          }}>
            {addendum.length} chars · {addendum.split('\n').length} lines
          </div>
        ) : (
          <div className="eye-empty" style={{ padding: 16 }}>No addendum yet. Eye will populate this as it learns.</div>
        )}
      </div>

      {/* Integrations */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Integrations</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg-surface)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Scripts Path
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
                (for query_logs and query_db)
              </span>
            </div>
            <input
              type="text"
              value={scriptsPath}
              onChange={e => { setScriptsPath(e.target.value); setDirty(true); }}
              placeholder="/path/to/your/scripts"
              style={{
                width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
                fontSize: 13, fontFamily: 'var(--font-mono)',
              }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Path to a repo containing opensearch-curl.py and rds.sh scripts. Used by query_logs and query_db tools.
              Requires <code style={{ background: 'var(--bg-interactive)', padding: '1px 4px', borderRadius: 3 }}>aws sso login</code> for auth.
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg-surface)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Repo Path
              <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
                (for query_ci_logs)
              </span>
            </div>
            <input
              type="text"
              value={repoPath}
              onChange={e => { setRepoPath(e.target.value); setDirty(true); }}
              placeholder="/path/to/your/repo"
              style={{
                width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
                fontSize: 13, fontFamily: 'var(--font-mono)',
              }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Default git repo path for the query_ci_logs tool (used to run gh commands).
            </div>
          </div>

          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, background: 'var(--bg-surface)' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Linear API Key
              {linearConfigured && <span style={{ color: 'var(--status-done)', marginLeft: 8, fontWeight: 400 }}>Configured</span>}
            </div>
            <input
              type="password"
              value={linearApiKey}
              onChange={e => { setLinearApiKey(e.target.value); setDirty(true); }}
              placeholder={linearConfigured ? 'Enter new key to replace...' : 'lin_api_...'}
              style={{
                width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border)',
                borderRadius: 6, padding: '6px 10px', color: 'var(--text-primary)',
                fontSize: 13, fontFamily: 'var(--font-mono)',
              }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Personal API key from Linear Settings &gt; API. Used by query_linear tool.
            </div>
          </div>
        </div>
      </div>

    </div>
    </div>
  );
}

// ─── PRs Tab ─────────────────────────────────────────────────────────────────

interface EyePr {
  id: string;
  url: string;
  title: string;
  description: string | null;
  proposal_id: string | null;
  status: 'draft' | 'open' | 'merged' | 'closed';
  created_at: number;
}

type PrFilter = 'active' | 'draft' | 'open' | 'merged' | 'all';

const PR_STATUS_COLORS: Record<string, string> = {
  draft:  '#f59e0b',
  open:   '#3fb950',
  merged: '#a371f7',
  closed: '#8b949e',
};

const PR_STATUS_LABELS: Record<string, string> = {
  draft:  'Draft',
  open:   'Open',
  merged: 'Merged',
  closed: 'Closed',
};

function prSortKey(pr: EyePr): number {
  // draft=0, open=1, merged=2, closed=3 — then by recency
  const order: Record<string, number> = { draft: 0, open: 1, merged: 2, closed: 3 };
  return (order[pr.status] ?? 9) * 1e13 + (Number.MAX_SAFE_INTEGER - pr.created_at);
}

function PrsTab() {
  const [prs, setPrs] = useState<EyePr[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<PrFilter>('active');

  const fetchPrs = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/prs');
      if (res.ok) setPrs(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/eye/prs/refresh', { method: 'POST' });
      if (res.ok) setPrs(await res.json());
    } catch { /* ignore */ }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchPrs();
  }, [fetchPrs]);

  useEffect(() => {
    const onPrNew = ({ pr }: { pr: EyePr }) => {
      setPrs(prev => [pr, ...prev.filter(p => p.id !== pr.id)]);
    };
    socket.on('eye:pr:new', onPrNew);
    return () => { socket.off('eye:pr:new', onPrNew); };
  }, []);

  const filtered = prs
    .filter(pr => {
      if (filter === 'active') return pr.status === 'draft' || pr.status === 'open';
      if (filter === 'draft')  return pr.status === 'draft';
      if (filter === 'open')   return pr.status === 'open';
      if (filter === 'merged') return pr.status === 'merged';
      return true; // 'all'
    })
    .sort((a, b) => prSortKey(a) - prSortKey(b));

  const counts = prs.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});
  const activeCount = (counts.draft || 0) + (counts.open || 0);

  const filterBtn = (f: PrFilter, label: string, count?: number) => (
    <button
      key={f}
      onClick={() => setFilter(f)}
      style={{
        fontSize: 11, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
        background: filter === f ? 'var(--accent)' : 'transparent',
        color: filter === f ? '#000' : 'var(--text-dim)',
        border: `1px solid ${filter === f ? 'var(--accent)' : 'var(--border)'}`,
        fontWeight: filter === f ? 600 : 400,
      }}
    >
      {label}{count !== undefined ? ` (${count})` : ''}
    </button>
  );

  if (loading) return <div className="eye-empty">Loading...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {filterBtn('active', 'Active', activeCount)}
        {filterBtn('draft',  'Draft',  counts.draft)}
        {filterBtn('open',   'Open',   counts.open)}
        {filterBtn('merged', 'Merged', counts.merged)}
        {filterBtn('all',    'All',    prs.length)}
        <button
          onClick={refresh}
          disabled={refreshing}
          style={{
            marginLeft: 'auto', fontSize: 11, padding: '3px 9px', borderRadius: 5,
            background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
            cursor: 'pointer', opacity: refreshing ? 0.5 : 1,
          }}
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="eye-empty">
          {prs.length === 0
            ? 'No PRs created yet. Eye will list PRs here when it implements approved proposals.'
            : `No ${filter === 'active' ? 'active' : filter} PRs.`}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map(pr => {
            const statusColor = PR_STATUS_COLORS[pr.status] || 'var(--text-dim)';
            return (
              <div key={pr.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', background: 'var(--bg-surface)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill={statusColor} style={{ flexShrink: 0, marginTop: 2 }}>
                    <path d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}
                      >
                        {pr.title}
                      </a>
                      <span style={{
                        flexShrink: 0, fontSize: 10, padding: '1px 6px', borderRadius: 10,
                        background: `${statusColor}22`, color: statusColor,
                        border: `1px solid ${statusColor}55`, fontWeight: 600,
                      }}>
                        {PR_STATUS_LABELS[pr.status] ?? pr.status}
                      </span>
                    </div>
                    {pr.description && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{pr.description}</div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                      {new Date(pr.created_at).toLocaleString()}
                      {pr.proposal_id && <span style={{ marginLeft: 8 }}>· linked to proposal</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── PR Reviews Tab ──────────────────────────────────────────────────────────

interface PrReview {
  id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_author: string | null;
  repo: string;
  summary: string;
  comments: string;
  status: string;
  github_review_id: string | null;
  needs_reply?: boolean;
  created_at: number;
  updated_at: number;
}

interface PrReviewMessage {
  id: string;
  review_id: string;
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

interface ReviewComment {
  file: string;
  line?: number;
  body: string;
  severity: 'info' | 'suggestion' | 'warning' | 'issue';
  codex_confirmed?: boolean;
}

const SEVERITY_COLORS: Record<string, string> = {
  info: 'var(--text-dim)',
  suggestion: '#58a6ff',
  warning: '#f59e0b',
  issue: '#f85149',
};

const SEVERITY_ICONS: Record<string, string> = {
  info: 'ℹ',
  suggestion: '💡',
  warning: '⚠️',
  issue: '🔴',
};

function AutoResizeTextarea({ value, onChange, onSubmit, placeholder, style }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
      placeholder={placeholder}
      rows={1}
      style={{ resize: 'none', overflow: 'hidden', fontFamily: 'inherit', lineHeight: 1.4, ...style }}
    />
  );
}

function PrReviewsTab() {
  const [reviews, setReviews] = useState<PrReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, PrReviewMessage[]>>({});
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [deleteReasons, setDeleteReasons] = useState<Record<string, string>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Record<string, boolean>>({});

  const fetchReviews = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/pr-reviews');
      if (res.ok) {
        const data: PrReview[] = await res.json();
        setReviews(data);
        // Load messages for all reviews
        const msgs: Record<string, PrReviewMessage[]> = {};
        await Promise.all(data.map(async r => {
          try {
            const mr = await fetch(`/api/eye/pr-reviews/${r.id}/messages`);
            if (mr.ok) msgs[r.id] = await mr.json();
          } catch { /* ignore */ }
        }));
        setMessages(msgs);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  useEffect(() => {
    const onNew = ({ review }: { review: PrReview }) => {
      setReviews(prev => [review, ...prev.filter(r => r.id !== review.id)]);
    };
    const onUpdate = ({ review }: { review: PrReview }) => {
      if (review.status === 'dismissed') {
        setReviews(prev => prev.filter(r => r.id !== review.id));
      } else {
        setReviews(prev => prev.map(r => r.id === review.id ? review : r));
      }
    };
    const onMessage = ({ message }: { message: PrReviewMessage }) => {
      setMessages(prev => ({
        ...prev,
        [message.review_id]: [...(prev[message.review_id] ?? []), message],
      }));
    };
    socket.on('eye:pr-review:new', onNew);
    socket.on('eye:pr-review:update', onUpdate);
    socket.on('eye:pr-review:message', onMessage);
    return () => {
      socket.off('eye:pr-review:new', onNew);
      socket.off('eye:pr-review:update', onUpdate);
      socket.off('eye:pr-review:message', onMessage);
    };
  }, []);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sendMessage = async (reviewId: string) => {
    const content = replyInputs[reviewId]?.trim();
    if (!content) return;
    setReplyInputs(prev => ({ ...prev, [reviewId]: '' }));
    try {
      await fetch(`/api/eye/pr-reviews/${reviewId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
    } catch { /* ignore */ }
  };

  const submitToGitHub = async (reviewId: string) => {
    setSubmitting(prev => ({ ...prev, [reviewId]: true }));
    try {
      const res = await fetch(`/api/eye/pr-reviews/${reviewId}/submit`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(`Submit failed: ${err.error}`);
      }
    } catch { /* ignore */ }
    setSubmitting(prev => ({ ...prev, [reviewId]: false }));
  };

  const deleteReview = async (reviewId: string) => {
    setDeleting(prev => ({ ...prev, [reviewId]: true }));
    try {
      const res = await fetch(`/api/eye/pr-reviews/${reviewId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReasons[reviewId] || '' }),
      });
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.id !== reviewId));
        setShowDeleteConfirm(prev => ({ ...prev, [reviewId]: false }));
        setDeleteReasons(prev => ({ ...prev, [reviewId]: '' }));
      } else {
        const err = await res.json();
        alert(`Delete failed: ${err.error}`);
      }
    } catch { /* ignore */ }
    setDeleting(prev => ({ ...prev, [reviewId]: false }));
  };

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (reviews.length === 0) return <div className="eye-empty">No PR reviews yet. Eye will review open PRs and show findings here.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
      {reviews.map(review => {
        let comments: ReviewComment[] = [];
        try { comments = JSON.parse(review.comments); } catch { /* ignore */ }
        const isExpanded = expandedIds.has(review.id);
        const reviewMessages = messages[review.id] ?? [];
        const severityCounts = comments.reduce<Record<string, number>>((acc, c) => {
          acc[c.severity] = (acc[c.severity] || 0) + 1;
          return acc;
        }, {});
        const severitySummary = ['issue', 'warning', 'suggestion', 'info']
          .filter(s => severityCounts[s])
          .map(s => `${severityCounts[s]} ${s}${severityCounts[s]! > 1 ? 's' : ''}`)
          .join(', ');
        const isDraft = review.status === 'draft';
        const hasGhReview = !!review.github_review_id;

        return (
          <div key={review.id} style={{ border: `1px solid ${review.needs_reply ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, padding: 12, background: 'var(--bg-surface)' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <a
                    href={review.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none' }}
                  >
                    PR #{review.pr_number} — {review.pr_title}
                  </a>
                  {review.needs_reply && (
                    <span style={{ fontSize: 10, background: 'var(--accent)', color: '#000', borderRadius: 4, padding: '1px 5px', fontWeight: 600 }}>
                      needs reply
                    </span>
                  )}
                  {review.status === 'submitted' && (
                    <span style={{ fontSize: 10, background: 'var(--status-done)', color: '#000', borderRadius: 4, padding: '1px 5px' }}>
                      submitted
                    </span>
                  )}
                  {isDraft && hasGhReview && (
                    <span style={{ fontSize: 10, background: '#f59e0b33', color: '#f59e0b', borderRadius: 4, padding: '1px 5px', border: '1px solid #f59e0b55' }}>
                      pending on GitHub
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                  {review.pr_author && <span>by {review.pr_author}</span>}
                  {comments.length > 0 && <span>{review.pr_author ? ' · ' : ''}{comments.length} comment{comments.length !== 1 ? 's' : ''}</span>}
                  {severitySummary && <span> · {severitySummary}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                {isDraft && hasGhReview && (
                  <button
                    onClick={() => submitToGitHub(review.id)}
                    disabled={submitting[review.id]}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 5,
                      background: 'var(--accent)', color: '#000', border: 'none', cursor: 'pointer',
                      fontWeight: 600, opacity: submitting[review.id] ? 0.6 : 1,
                    }}
                  >
                    {submitting[review.id] ? 'Submitting…' : 'Submit review'}
                  </button>
                )}
                {review.status !== 'dismissed' && (
                  <button
                    onClick={() => setShowDeleteConfirm(prev => ({ ...prev, [review.id]: !prev[review.id] }))}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 5,
                      background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
                      cursor: 'pointer', fontWeight: 500,
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {showDeleteConfirm[review.id] && (
              <div style={{
                marginTop: 8, padding: '8px 10px', borderRadius: 6,
                border: '1px solid #ef444455', background: '#ef444411',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  Delete this review? It will be removed from GitHub if pending.
                </div>
                <input
                  type="text"
                  value={deleteReasons[review.id] ?? ''}
                  onChange={e => setDeleteReasons(prev => ({ ...prev, [review.id]: e.target.value }))}
                  placeholder="Optional: why are you deleting this? (helps Eye learn)"
                  style={{
                    fontSize: 12, padding: '5px 8px', borderRadius: 5,
                    border: '1px solid var(--border)', background: 'var(--bg-primary)',
                    color: 'var(--text-primary)', outline: 'none', width: '100%',
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => deleteReview(review.id)}
                    disabled={deleting[review.id]}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 5,
                      background: '#ef4444', color: '#fff', border: 'none',
                      cursor: 'pointer', fontWeight: 600, opacity: deleting[review.id] ? 0.6 : 1,
                    }}
                  >
                    {deleting[review.id] ? 'Deleting…' : 'Confirm delete'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(prev => ({ ...prev, [review.id]: false }))}
                    style={{
                      fontSize: 11, padding: '4px 10px', borderRadius: 5,
                      background: 'transparent', color: 'var(--text-dim)', border: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {review.summary && (
              <div style={{
                fontSize: 12, color: 'var(--text-primary)', marginTop: 8,
                display: '-webkit-box', WebkitLineClamp: isExpanded ? undefined : 2,
                WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.5,
              }}>
                {review.summary}
              </div>
            )}

            {comments.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <button
                  onClick={() => toggleExpanded(review.id)}
                  style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}
                >
                  {isExpanded ? '▾ Hide comments' : `▸ Show ${comments.length} comment${comments.length !== 1 ? 's' : ''}`}
                </button>
                {isExpanded && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    {comments.map((c, i) => (
                      <div key={i} style={{
                        padding: '8px 10px', borderRadius: 6,
                        border: `1px solid ${SEVERITY_COLORS[c.severity] || 'var(--border)'}33`,
                        background: 'var(--bg-primary)',
                      }}>
                        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 4, fontFamily: 'var(--font-mono)' }}>
                          {c.file}{c.line ? `:${c.line}` : ''}
                        </div>
                        <div style={{ fontSize: 12, color: SEVERITY_COLORS[c.severity] || 'var(--text-primary)', lineHeight: 1.5 }}>
                          {SEVERITY_ICONS[c.severity] || ''} {c.body}
                        </div>
                        {c.codex_confirmed && (
                          <span style={{ fontSize: 11, color: 'var(--status-done)', marginTop: 4, display: 'inline-block' }}>
                            ✓ Codex confirmed
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Message thread */}
            {reviewMessages.length > 0 && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {reviewMessages.map(msg => (
                  <div key={msg.id} style={{
                    padding: '6px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
                    background: msg.role === 'user' ? 'var(--bg-primary)' : 'var(--bg-surface)',
                    border: '1px solid var(--border)',
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '90%',
                  }}>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 2 }}>{msg.role === 'user' ? 'You' : 'Eye'}</div>
                    {msg.content}
                  </div>
                ))}
              </div>
            )}

            {/* Reply input */}
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'flex-end' }}>
              <AutoResizeTextarea
                value={replyInputs[review.id] ?? ''}
                onChange={v => setReplyInputs(prev => ({ ...prev, [review.id]: v }))}
                onSubmit={() => sendMessage(review.id)}
                placeholder="Reply to Eye about this review…"
                style={{
                  flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 5,
                  border: '1px solid var(--border)', background: 'var(--bg-primary)',
                  color: 'var(--text-primary)', outline: 'none',
                }}
              />
              <button
                onClick={() => sendMessage(review.id)}
                disabled={!replyInputs[review.id]?.trim()}
                style={{
                  fontSize: 11, padding: '5px 10px', borderRadius: 5,
                  background: 'var(--accent)', color: '#000', border: 'none',
                  cursor: 'pointer', fontWeight: 600, opacity: !replyInputs[review.id]?.trim() ? 0.4 : 1,
                }}
              >
                Send
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function EyePanel({ discussions, proposals, onClose }: EyePanelProps) {
  const [discMessages, setDiscMessages] = useState<Record<string, DiscussionMessage[]>>({});
  const [propMessages, setPropMessages] = useState<Record<string, ProposalMessage[]>>({});
  const [selectedDiscId, setSelectedDiscId] = useState<string | null>(null);
  const [discFilter, setDiscFilter] = useState<'needs-reply' | 'open' | 'resolved' | 'all'>('needs-reply');
  const [propFilter, setPropFilter] = useState<'needs-action' | 'active' | 'done' | 'all'>('needs-action');
  const [activeTab, setActiveTab] = useState<'interact' | 'activity' | 'prs' | 'reviews' | 'summary' | 'configure'>('interact');

  // Eye lifecycle
  const [eyeStatus, setEyeStatus] = useState<EyeStatus>({ running: false, active: false, scheduledAt: null, jobId: null, cycleCount: 0 });
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/status');
      if (res.ok) setEyeStatus(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);
  useEffect(() => {
    const id = setInterval(fetchStatus, 10_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const handleStart = async () => {
    setStarting(true);
    try {
      const res = await fetch('/api/eye/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) await fetchStatus();
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      const res = await fetch('/api/eye/stop', { method: 'POST' });
      if (res.ok) await fetchStatus();
    } finally {
      setStopping(false);
    }
  };

  // Fetch messages for discussions
  const fetchDiscMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/eye/discussions/${id}/messages`);
      const msgs = await res.json();
      setDiscMessages(prev => ({ ...prev, [id]: msgs }));
    } catch { /* ignore */ }
  }, []);

  const fetchPropMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/eye/proposals/${id}/messages`);
      const msgs = await res.json();
      setPropMessages(prev => ({ ...prev, [id]: msgs }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    for (const d of discussions) {
      if (!discMessages[d.id]) fetchDiscMessages(d.id);
    }
  }, [discussions]);

  useEffect(() => {
    for (const p of proposals) {
      if (!propMessages[p.id]) fetchPropMessages(p.id);
    }
  }, [proposals]);

  // Real-time socket updates
  useEffect(() => {
    const onDiscMsg = ({ message }: { message: DiscussionMessage }) => {
      setDiscMessages(prev => {
        const existing = prev[message.discussion_id] ?? [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [message.discussion_id]: [...existing, message] };
      });
    };
    const onPropMsg = ({ message }: { message: ProposalMessage }) => {
      setPropMessages(prev => {
        const existing = prev[message.proposal_id] ?? [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [message.proposal_id]: [...existing, message] };
      });
    };
    const onDiscNew = ({ discussion, message }: { discussion: Discussion; message: DiscussionMessage }) => {
      setDiscMessages(prev => ({ ...prev, [discussion.id]: [message] }));
    };
    socket.on('eye:discussion:message', onDiscMsg);
    socket.on('eye:proposal:message', onPropMsg);
    socket.on('eye:discussion:new', onDiscNew);
    return () => {
      socket.off('eye:discussion:message', onDiscMsg);
      socket.off('eye:proposal:message', onPropMsg);
      socket.off('eye:discussion:new', onDiscNew);
    };
  }, []);

  const sendDiscMessage = async (discId: string, content: string) => {
    await fetch(`/api/eye/discussions/${discId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    fetchDiscMessages(discId);
  };

  const resolveDiscussion = async (id: string) => {
    await fetch(`/api/eye/discussions/${id}/resolve`, { method: 'POST' });
  };

  const reopenDiscussion = async (id: string) => {
    await fetch(`/api/eye/discussions/${id}/reopen`, { method: 'POST' });
  };

  const approveProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/approve`, { method: 'POST' });
  };

  const rejectProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/reject`, { method: 'POST' });
  };

  const retryProposal = async (id: string) => {
    await fetch(`/api/eye/proposals/${id}/retry`, { method: 'POST' });
  };

  const sendPropMessage = async (propId: string, content: string) => {
    await fetch(`/api/eye/proposals/${propId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    fetchPropMessages(propId);
  };

  const filteredDiscussions = discussions
    .filter(d => {
      if (discFilter === 'all') return true;
      if (discFilter === 'resolved') return d.status === 'resolved';
      if (discFilter === 'open') return d.status === 'open';
      // 'needs-reply': open discussions where last message is from Eye and requires a reply
      if (d.status !== 'open') return false;
      const msgs = discMessages[d.id];
      if (!msgs) return false; // not loaded yet — hide until messages fetch completes
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      return last.role === 'eye' && last.requires_reply === true;
    })
    .sort((a, b) => {
      const pw = (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
      if (pw !== 0) return pw;
      return b.updated_at - a.updated_at;
    });

  const filteredProposals = proposals
    .filter(p => {
      if (propFilter === 'all') return true;
      if (propFilter === 'done') return ['done', 'rejected'].includes(p.status);
      if (propFilter === 'active') return !['done', 'rejected'].includes(p.status);
      // 'needs-action': pending (needs approve/reject), failed (needs retry/cancel),
      // + discussing where Eye's last msg is unread
      if (p.status === 'pending' || p.status === 'failed') return true;
      if (p.status === 'discussing') {
        const msgs = propMessages[p.id];
        if (!msgs) return false; // not loaded yet — hide until messages fetch completes
        return msgs.length === 0 || msgs[msgs.length - 1].role === 'eye';
      }
      return false;
    });

  return (
    <div className="eye-panel">
      {/* Header */}
      <div className="eye-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 className="eye-panel-title">Eye</h2>
          <span
            className="eye-status-dot"
            style={{
              background: eyeStatus.active ? 'var(--status-running)' :
                eyeStatus.running ? 'var(--status-waiting)' :
                'var(--text-muted)'
            }}
            title={eyeStatus.active ? 'Active' : eyeStatus.running ? 'Sleeping' : 'Stopped'}
          />
          <span style={{ fontSize: 12, color: eyeStatus.failed ? 'var(--status-failed)' : 'var(--text-muted)' }}>
            {eyeStatus.active
              ? `Running (cycle ${eyeStatus.cycleCount})`
              : eyeStatus.failed
                ? `Last cycle failed — retrying`
                : eyeStatus.running
                  ? eyeStatus.scheduledAt
                    ? `Sleeping — next cycle ${formatNextCycle(eyeStatus.scheduledAt)}`
                    : `Sleeping (cycle ${eyeStatus.cycleCount})`
                  : 'Stopped'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {eyeStatus.running ? (
            <button className="btn btn-sm eye-btn-reject" onClick={handleStop} disabled={stopping}>
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          ) : (
            <button className="btn btn-sm eye-btn-approve" onClick={handleStart} disabled={starting}>
              {starting ? 'Starting...' : 'Start'}
            </button>
          )}
          <button className="btn-icon" onClick={onClose} title="Close" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="eye-tab-bar">
        <button className={`eye-tab ${activeTab === 'interact' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('interact')}>
          Discussions & Proposals
        </button>
        <button className={`eye-tab ${activeTab === 'activity' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('activity')}>
          Activity
        </button>
        <button className={`eye-tab ${activeTab === 'prs' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('prs')}>
          PRs
        </button>
        <button className={`eye-tab ${activeTab === 'reviews' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('reviews')}>
          Reviews
        </button>
        <button className={`eye-tab ${activeTab === 'summary' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('summary')}>
          Summary
        </button>
        <button className={`eye-tab ${activeTab === 'configure' ? 'eye-tab-active' : ''}`} onClick={() => setActiveTab('configure')}>
          Configure
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'interact' ? (
        <div className="eye-columns">
          {/* Left: Discussions */}
          <div className="eye-col">
            <div className="eye-col-header">
              <h3>Discussions</h3>
              <div className="eye-filter-tabs">
                <button className={`eye-filter-tab ${discFilter === 'needs-reply' ? 'active' : ''}`} onClick={() => setDiscFilter('needs-reply')}>Needs reply</button>
                <button className={`eye-filter-tab ${discFilter === 'open' ? 'active' : ''}`} onClick={() => setDiscFilter('open')}>Open</button>
                <button className={`eye-filter-tab ${discFilter === 'resolved' ? 'active' : ''}`} onClick={() => setDiscFilter('resolved')}>Resolved</button>
                <button className={`eye-filter-tab ${discFilter === 'all' ? 'active' : ''}`} onClick={() => setDiscFilter('all')}>All</button>
              </div>
            </div>
            <SendToEye onCreated={(id) => { setDiscFilter('open'); setSelectedDiscId(id); }} />
            <div className="eye-col-body">
              {filteredDiscussions.length === 0 && <div className="eye-empty">No discussions yet</div>}
              {filteredDiscussions.map(d => {
                const msgs = discMessages[d.id] ?? [];
                const lastMsg = msgs[msgs.length - 1];
                const hasUnread = lastMsg?.role === 'eye' && lastMsg.requires_reply === true;
                const isSelected = selectedDiscId === d.id;
                return (
                  <div key={d.id} className={`eye-disc-card ${isSelected ? 'eye-disc-card-selected' : ''}`} onClick={() => setSelectedDiscId(isSelected ? null : d.id)}>
                    <div className="eye-disc-card-top">
                      <span className="eye-disc-icon" style={{ background: CATEGORY_COLORS[d.category], color: '#0d1117' }} title={d.category}>
                        {CATEGORY_ICONS[d.category]}
                      </span>
                      <span className="eye-disc-topic">{d.topic}</span>
                      {d.priority === 'high' && <span className="eye-disc-priority-badge">HIGH</span>}
                      {hasUnread && <span className="eye-disc-needs-reply" title="Eye replied — needs your response" />}
                      <span className="eye-disc-count">{msgs.length}</span>
                    </div>
                    {lastMsg && (
                      <div className={`eye-disc-preview ${hasUnread ? 'eye-disc-preview-unread' : ''}`}>
                        {lastMsg.content.slice(0, 120)}{lastMsg.content.length > 120 ? '...' : ''}
                      </div>
                    )}
                    {isSelected && (
                      <div className="eye-disc-thread-wrapper" onClick={e => e.stopPropagation()}>
                        <DiscussionThread
                          messages={msgs}
                          onSendMessage={(content) => sendDiscMessage(d.id, content)}
                          status={d.status}
                          onResolve={d.status === 'open' ? () => resolveDiscussion(d.id) : undefined}
                          onReopen={d.status === 'resolved' ? () => reopenDiscussion(d.id) : undefined}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Proposals */}
          <div className="eye-col">
            <div className="eye-col-header">
              <h3>Proposals</h3>
              <div className="eye-filter-tabs">
                <button className={`eye-filter-tab ${propFilter === 'needs-action' ? 'active' : ''}`} onClick={() => setPropFilter('needs-action')}>Needs action</button>
                <button className={`eye-filter-tab ${propFilter === 'active' ? 'active' : ''}`} onClick={() => setPropFilter('active')}>Active</button>
                <button className={`eye-filter-tab ${propFilter === 'done' ? 'active' : ''}`} onClick={() => setPropFilter('done')}>Done</button>
                <button className={`eye-filter-tab ${propFilter === 'all' ? 'active' : ''}`} onClick={() => setPropFilter('all')}>All</button>
              </div>
            </div>
            <div className="eye-col-body">
              {filteredProposals.length === 0 && <div className="eye-empty">No proposals yet</div>}
              {filteredProposals.map(p => {
                const pMsgs = propMessages[p.id] ?? [];
                const lastPMsg = pMsgs[pMsgs.length - 1];
                const propHasUnread = p.status === 'pending' || p.status === 'failed' || lastPMsg?.role === 'eye';
                return (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    messages={pMsgs}
                    hasUnread={propHasUnread}
                    onApprove={approveProposal}
                    onReject={rejectProposal}
                    onRetry={retryProposal}
                    onSendMessage={sendPropMessage}
                  />
                );
              })}
            </div>
          </div>
        </div>
      ) : activeTab === 'activity' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <ActivityTab />
        </div>
      ) : activeTab === 'prs' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <PrsTab />
        </div>
      ) : activeTab === 'reviews' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <PrReviewsTab />
        </div>
      ) : activeTab === 'summary' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <SummaryTab />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <ConfigureTab />
        </div>
      )}
    </div>
  );
}
