import React, { useState, useEffect } from 'react';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [maxConcurrent, setMaxConcurrent] = useState<number>(20);
  const [botName, setBotName] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const [systemPromptAppendix, setSystemPromptAppendix] = useState('');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [worktreeStats, setWorktreeStats] = useState<{ active: number; cleaned: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setMaxConcurrent(data.maxConcurrentAgents);
        setBotName(data.botName ?? '');
        setDefaultModel(data.defaultModel ?? '');
        setAnthropicApiKey(data.anthropicApiKey ?? '');
        setApiKeySet(!!data.anthropicApiKeySet);
        setSystemPromptAppendix(data.systemPromptAppendix ?? '');
        setGitAuthorName(data.gitAuthorName ?? '');
        setGitAuthorEmail(data.gitAuthorEmail ?? '');
        setVersion(data.version ?? null);
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
        body: JSON.stringify({ maxConcurrentAgents: maxConcurrent, botName, defaultModel, anthropicApiKey, systemPromptAppendix, gitAuthorName, gitAuthorEmail }),
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
            <label>Default Model</label>
            <select
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
              style={{ width: 280 }}
            >
              <option value="">Auto-classify (haiku/sonnet/opus)</option>
              <option value="claude-haiku-4-5-20251001">Haiku</option>
              <option value="claude-sonnet-4-6[1m]">Sonnet</option>
              <option value="claude-opus-4-6[1m]">Opus</option>
            </select>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              When set, all jobs without an explicit model use this instead of LLM-based classification.
            </div>
          </div>
          <div className="form-group">
            <label>Anthropic API Key</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="password"
                value={anthropicApiKey}
                onChange={e => setAnthropicApiKey(e.target.value)}
                placeholder={apiKeySet ? '(saved — paste new key to replace)' : 'sk-ant-...'}
                style={{ flex: 1 }}
              />
              {apiKeySet && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => { setAnthropicApiKey(''); setApiKeySet(false); }}
                  style={{ flexShrink: 0 }}
                >
                  Clear
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              Enables fast title generation and model classification via direct API calls instead of the slow CLI.
            </div>
          </div>
          <div className="form-group">
            <label>Git Author</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                value={gitAuthorName}
                onChange={e => setGitAuthorName(e.target.value)}
                placeholder="Name (e.g. AaryamanBhute)"
                style={{ flex: 1 }}
              />
              <input
                type="text"
                value={gitAuthorEmail}
                onChange={e => setGitAuthorEmail(e.target.value)}
                placeholder="Email (e.g. user@example.com)"
                style={{ flex: 1 }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              Git identity used for agent commits. Leave blank to use the system default.
            </div>
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

          <div className="form-group" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <label>Server</label>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              Pull latest code, rebuild, and restart the server.
            </div>
            <button
              className="btn btn-secondary btn-sm"
              disabled={restarting}
              onClick={async () => {
                if (!confirm('This will restart the server. Continue?')) return;
                setRestarting(true);
                try { await fetch('/api/admin/restart', { method: 'POST' }); } catch { /* server will die */ }
                // Poll until server comes back
                const poll = () => {
                  setTimeout(async () => {
                    try {
                      const r = await fetch('/api/settings');
                      if (r.ok) window.location.reload();
                      else poll();
                    } catch { poll(); }
                  }, 2000);
                };
                poll();
              }}
            >
              {restarting ? 'Restarting…' : 'Pull & Restart'}
            </button>
          </div>
          {version && (
            <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-secondary)' }}>
              Version: <code style={{ fontSize: 11 }}>{version}</code>
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
