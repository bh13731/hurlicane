import React, { useState, useEffect, useCallback } from 'react';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

const TIMEFRAMES = [
  { label: '1 day',   days: 1 },
  { label: '7 days',  days: 7 },
  { label: '30 days', days: 30 },
  { label: '3 months', days: 90 },
];

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  return '$' + n.toFixed(2);
}

function shortModel(name: string): string {
  return name.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface DailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
}

interface UsageData {
  daily: DailyEntry[];
  totals: Totals | null;
}

interface UsageModalProps {
  onClose: () => void;
}

const tdStyle: React.CSSProperties = {
  padding: '7px 12px',
  borderBottom: '1px solid #30363d',
  whiteSpace: 'nowrap',
};

const tdNum: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const tdCost: React.CSSProperties = {
  ...tdNum,
  color: '#3fb950',
};

export function UsageModal({ onClose }: UsageModalProps) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchUsage = useCallback(async (numDays: number) => {
    setLoading(true);
    setError('');
    setData(null);
    try {
      const since = daysAgo(numDays);
      const res = await fetch(`/api/usage?since=${encodeURIComponent(since)}`);
      const text = await res.text();
      if (!text) {
        setError('Server returned an empty response. The server may be restarting — try again.');
        return;
      }
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        setError(`Server returned non-JSON response: ${text.slice(0, 120)}`);
        return;
      }
      if (!res.ok) {
        setError(json.error ?? 'Failed to fetch usage');
      } else {
        setData(json as UsageData);
      }
    } catch (e: any) {
      setError(e.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage(days);
  }, [days, fetchUsage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: '90vw', maxWidth: 1100 }}
      >
        <div className="modal-header">
          <h2>Usage</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf.days}
                  className={`btn btn-sm ${days === tf.days ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setDays(tf.days)}
                  disabled={loading}
                >
                  {tf.label}
                </button>
              ))}
            </div>
            <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div style={{ padding: '16px 20px', overflowX: 'auto' }}>
          {loading && (
            <div style={{ color: '#8b949e', textAlign: 'center', padding: 40 }}>
              Loading usage data...
            </div>
          )}
          {error && (
            <div style={{ color: '#f85149', padding: 12, background: '#3d1a1a', borderRadius: 6 }}>
              {error}
            </div>
          )}
          {!loading && !error && data && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#21262d' }}>
                  <th style={{ ...tdStyle, textAlign: 'left', color: '#8b949e', fontWeight: 600 }}>Date</th>
                  <th style={{ ...tdStyle, textAlign: 'left', color: '#8b949e', fontWeight: 600 }}>Models</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Input</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Output</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Cache Write</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Cache Read</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Total Tokens</th>
                  <th style={{ ...tdNum, color: '#8b949e', fontWeight: 600 }}>Cost (USD)</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((entry) => (
                  <tr key={entry.date} style={{ borderBottom: '1px solid #21262d' }}>
                    <td style={{ ...tdStyle, color: '#e6edf3' }}>{entry.date}</td>
                    <td style={{ ...tdStyle, color: '#8b949e', fontSize: 12 }}>
                      {entry.modelsUsed.map(shortModel).join(', ')}
                    </td>
                    <td style={tdNum}>{fmt(entry.inputTokens)}</td>
                    <td style={tdNum}>{fmt(entry.outputTokens)}</td>
                    <td style={tdNum}>{fmt(entry.cacheCreationTokens)}</td>
                    <td style={tdNum}>{fmt(entry.cacheReadTokens)}</td>
                    <td style={tdNum}>{fmt(entry.totalTokens)}</td>
                    <td style={tdCost}>{fmtCost(entry.totalCost)}</td>
                  </tr>
                ))}
                {data.daily.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ ...tdStyle, textAlign: 'center', color: '#8b949e', padding: 40 }}>
                      No usage data for this period.
                    </td>
                  </tr>
                )}
              </tbody>
              {data.totals && data.daily.length > 1 && (
                <tfoot>
                  <tr style={{ background: '#21262d', fontWeight: 600 }}>
                    <td style={{ ...tdStyle, color: '#e6edf3' }}>Total</td>
                    <td style={tdStyle} />
                    <td style={tdNum}>{fmt(data.totals.inputTokens)}</td>
                    <td style={tdNum}>{fmt(data.totals.outputTokens)}</td>
                    <td style={tdNum}>{fmt(data.totals.cacheCreationTokens)}</td>
                    <td style={tdNum}>{fmt(data.totals.cacheReadTokens)}</td>
                    <td style={tdNum}>{fmt(data.totals.totalTokens)}</td>
                    <td style={tdCost}>{fmtCost(data.totals.totalCost)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          {!loading && !error && !data && (
            <div style={{ color: '#8b949e', textAlign: 'center', padding: 40 }}>
              No usage data found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
