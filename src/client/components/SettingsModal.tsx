import React, { useState, useEffect } from 'react';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [maxConcurrent, setMaxConcurrent] = useState<number>(20);
  const [botName, setBotName] = useState('');
  const [systemPromptAppendix, setSystemPromptAppendix] = useState('');
  const [saving, setSaving] = useState(false);
  const [worktreeStats, setWorktreeStats] = useState<{ active: number; cleaned: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setMaxConcurrent(data.maxConcurrentAgents);
        setBotName(data.botName ?? '');
        setSystemPromptAppendix(data.systemPromptAppendix ?? '');
      })
      .catch(() => {});
    fetch('/api/worktrees/stats')
      .then(r => r.json())
      .then(setWorktreeStats)
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxConcurrentAgents: maxConcurrent, botName, systemPromptAppendix }),
      });
      if (res.ok) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      const res = await fetch('/api/worktrees/cleanup', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        // Refresh stats
        const statsRes = await fetch('/api/worktrees/stats');
        if (statsRes.ok) setWorktreeStats(await statsRes.json());
      }
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Bot Name</label>
            <input
              type="text"
              value={botName}
              onChange={e => setBotName(e.target.value)}
              placeholder="e.g. hurlicane"
              style={{ width: 200 }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              When set, commits and comments must start with [{botName || '...'}]. Eye ignores events from this name.
            </div>
          </div>
          <div className="form-group">
            <label>Max Concurrent Agents</label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxConcurrent}
              onChange={e => setMaxConcurrent(Number(e.target.value))}
              style={{ width: 80 }}
            />
          </div>
          <div className="form-group">
            <label>System Prompt Appendix</label>
            <textarea
              value={systemPromptAppendix}
              onChange={e => setSystemPromptAppendix(e.target.value)}
              placeholder="Additional instructions appended to every agent's system prompt..."
              rows={6}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
            />
          </div>

          {worktreeStats && (
            <div className="form-group" style={{ marginTop: 16 }}>
              <label>Worktrees</label>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Active: {worktreeStats.active} | Cleaned: {worktreeStats.cleaned}
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCleanup}
                disabled={cleaning || worktreeStats.active === 0}
              >
                {cleaning ? 'Cleaning…' : 'Clean up now'}
              </button>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
