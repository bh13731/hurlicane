import React, { useState } from 'react';
import type { AgentWithJob } from '@shared/types';

// ── RetryButton ─────────────────────────────────────────────────────────────
export function RetryButton({ agentId, onRetried }: { agentId: string; onRetried: (a: AgentWithJob) => void }) {
  const [loading, setLoading] = useState(false);
  const [interactive, setInteractive] = useState(false);

  const handleRetry = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interactive }),
      });
      if (res.ok) {
        const newAgent: AgentWithJob = await res.json();
        onRetried(newAgent);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="continue-area">
      <div className="continue-form">
        <span className="continue-label">No session to resume.</span>
        <label className="continue-interactive-toggle" title="Open as interactive tmux session">
          <input type="checkbox" checked={interactive} onChange={e => setInteractive(e.target.checked)} />
          Interactive
        </label>
        <button className="btn btn-secondary btn-sm" onClick={handleRetry} disabled={loading}>
          {loading ? '\u2026' : '\u21ba Retry'}
        </button>
      </div>
    </div>
  );
}

// ── CancelButton ────────────────────────────────────────────────────────────
export function CancelButton({ agentId, onCancelled }: { agentId: string; onCancelled: () => void }) {
  const [loading, setLoading] = useState(false);

  const handleCancel = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await fetch(`/api/agents/${agentId}/cancel`, { method: 'POST' });
      onCancelled();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button className="btn btn-danger btn-sm" onClick={handleCancel} disabled={loading}>
      {loading ? '\u2026' : '\u25fb Cancel'}
    </button>
  );
}

// ── ContinueInput ───────────────────────────────────────────────────────────
export function ContinueInput({ agentId, onContinued }: { agentId: string; onContinued: (a: AgentWithJob) => void }) {
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [interactive, setInteractive] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msg.trim() || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.trim(), interactive }),
      });
      if (res.ok) {
        const newAgent: AgentWithJob = await res.json();
        onContinued(newAgent);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="continue-area">
      <form onSubmit={handleSubmit} className="continue-form">
        <span className="continue-label">Continue:</span>
        <input
          type="text"
          value={msg}
          onChange={e => setMsg(e.target.value)}
          placeholder="Send a follow-up message..."
          disabled={loading}
          autoFocus
        />
        <label className="continue-interactive-toggle" title="Open as interactive tmux session">
          <input type="checkbox" checked={interactive} onChange={e => setInteractive(e.target.checked)} />
          Interactive
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !msg.trim()}>
          {loading ? '\u2026' : 'Send'}
        </button>
      </form>
    </div>
  );
}
