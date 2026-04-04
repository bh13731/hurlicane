import React, { useState, useEffect, useCallback } from 'react';
import { ProposalCard } from './ProposalCard';
import socket from '../socket';
import type { Discussion, Proposal, ProposalMessage, AgentWithJob } from '@shared/types';
import { InlineOutput, StatusDot, formatDuration, formatTime, formatNextCycle } from './eye/utils';
import { DailySummary } from './eye/DailySummary';
import { EyeConfigPanel } from './eye/EyeConfigPanel';
import { PRReviewList } from './eye/PRReviewList';
import { DiscussionList } from './eye/DiscussionList';

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

// ─── Main Panel ───────────────────────────────────────────────────────────────

export function EyePanel({ discussions, proposals, onClose }: EyePanelProps) {
  const [propMessages, setPropMessages] = useState<Record<string, ProposalMessage[]>>({});
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

  // Fetch messages for proposals
  const fetchPropMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/eye/proposals/${id}/messages`);
      const msgs = await res.json();
      setPropMessages(prev => ({ ...prev, [id]: msgs }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    for (const p of proposals) {
      if (!propMessages[p.id]) fetchPropMessages(p.id);
    }
  }, [proposals]);

  // Real-time socket updates
  useEffect(() => {
    const onPropMsg = ({ message }: { message: ProposalMessage }) => {
      setPropMessages(prev => {
        const existing = prev[message.proposal_id] ?? [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [message.proposal_id]: [...existing, message] };
      });
    };
    socket.on('eye:proposal:message', onPropMsg);
    return () => {
      socket.off('eye:proposal:message', onPropMsg);
    };
  }, []);

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
          <DiscussionList discussions={discussions} />

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
          <PRReviewList />
        </div>
      ) : activeTab === 'summary' ? (
        <div className="eye-col-body" style={{ flex: 1 }}>
          <DailySummary />
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <EyeConfigPanel />
        </div>
      )}
    </div>
  );
}
