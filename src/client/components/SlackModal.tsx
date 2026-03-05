import React, { useState, useEffect, useCallback } from 'react';

interface SlackModalProps {
  onClose: () => void;
}

export function SlackModal({ onClose }: SlackModalProps) {
  const [botToken, setBotToken] = useState('');
  const [userId, setUserId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [savedMasked, setSavedMasked] = useState('');
  const [savedUserId, setSavedUserId] = useState('');

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/slack');
      if (!res.ok) return;
      const data = await res.json();
      setSavedMasked(data.botToken ?? '');
      setSavedUserId(data.userId ?? '');
      setUserId(data.userId ?? '');
      setBotToken('');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  useEffect(() => {
    setDirty(botToken !== '' || userId !== savedUserId);
  }, [botToken, userId, savedUserId]);

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const body: Record<string, string> = { userId };
      if (botToken) body.botToken = botToken;
      const res = await fetch('/api/slack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFeedback({ type: 'err', msg: data.error ?? 'Failed to save' });
        return;
      }
      const data = await res.json();
      setSavedMasked(data.botToken ?? '');
      setSavedUserId(data.userId ?? '');
      setBotToken('');
      setDirty(false);
      setFeedback({ type: 'ok', msg: 'Saved' });
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message ?? 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setFeedback(null);
    try {
      const body: Record<string, string> = {};
      if (botToken) body.botToken = botToken;
      if (userId) body.userId = userId;
      const res = await fetch('/api/slack/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFeedback({ type: 'err', msg: data.error ?? 'Test failed' });
        return;
      }
      setFeedback({ type: 'ok', msg: 'Test message sent — check your Slack DMs' });
    } catch (e: any) {
      setFeedback({ type: 'err', msg: e.message ?? 'Network error' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: '90vw', maxWidth: 480 }}>
        <div className="modal-header">
          <h2>Slack Notifications</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
            Get a Slack DM when a job or agent fails. Create a Slack app with <code>chat:write</code> scope and add the bot to your workspace.
          </p>

          <div className="form-group">
            <label>Bot Token</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showToken ? 'text' : 'password'}
                value={botToken}
                onChange={e => setBotToken(e.target.value)}
                placeholder={savedMasked || 'xoxb-...'}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setShowToken(!showToken)}
                type="button"
                style={{ whiteSpace: 'nowrap' }}
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>User ID</label>
            <input
              type="text"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              placeholder="U0123456789"
            />
            <div className="eye-field-hint">Your Slack member ID (Profile → ⋯ → Copy member ID)</div>
          </div>

          {feedback && (
            <div style={{
              padding: '8px 12px',
              borderRadius: 6,
              fontSize: 13,
              background: feedback.type === 'ok' ? 'var(--success-bg, rgba(46,160,67,0.15))' : 'var(--danger-bg, rgba(248,81,73,0.15))',
              color: feedback.type === 'ok' ? 'var(--success, #3fb950)' : 'var(--danger, #f85149)',
            }}>
              {feedback.msg}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? 'Sending...' : 'Test'}
            </button>
            {dirty && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
