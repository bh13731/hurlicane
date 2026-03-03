import React, { useState, useEffect } from 'react';

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [maxConcurrent, setMaxConcurrent] = useState<number>(20);
  const [apiKey, setApiKey] = useState('');
  const [maskedKey, setMaskedKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(data => {
        setMaxConcurrent(data.maxConcurrentAgents);
        setMaskedKey(data.anthropicApiKey || '');
        setHasKey(data.hasAnthropicApiKey);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { maxConcurrentAgents: maxConcurrent };
      if (apiKey) body.anthropicApiKey = apiKey;
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) onClose();
    } finally {
      setSaving(false);
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
            <label>Anthropic API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={hasKey ? maskedKey : 'sk-ant-...'}
            />
            {hasKey && !apiKey && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                Key is set. Enter a new value to replace it.
              </div>
            )}
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
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
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
