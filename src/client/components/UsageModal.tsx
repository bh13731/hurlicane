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

interface CodexDailyEntry {
  date: string;
  costUSD: number;
}

interface CodexTotals {
  costUSD: number;
}

interface CodexData {
  daily: CodexDailyEntry[];
  totals: CodexTotals | null;
}

interface UsageData {
  daily: DailyEntry[];
  totals: Totals | null;
  codex: CodexData | null;
}

interface UsageModalProps {
  onClose: () => void;
}

// Table styles now handled by .usage-table CSS classes

function filterToRange(raw: UsageData, numDays: number): UsageData {
  const since = daysAgo(numDays);
  const daily = raw.daily.filter(e => e.date.replace(/-/g, '') >= since);
  const totals: Totals = {
    inputTokens: daily.reduce((s, e) => s + e.inputTokens, 0),
    outputTokens: daily.reduce((s, e) => s + e.outputTokens, 0),
    cacheCreationTokens: daily.reduce((s, e) => s + e.cacheCreationTokens, 0),
    cacheReadTokens: daily.reduce((s, e) => s + e.cacheReadTokens, 0),
    totalTokens: daily.reduce((s, e) => s + e.totalTokens, 0),
    totalCost: daily.reduce((s, e) => s + e.totalCost, 0),
  };
  let codex = raw.codex;
  if (codex) {
    const codexDaily = codex.daily.filter(e => e.date.replace(/-/g, '') >= since);
    codex = { daily: codexDaily, totals: { costUSD: codexDaily.reduce((s, e) => s + e.costUSD, 0) } };
  }
  return { daily, totals, codex };
}

export function UsageModal({ onClose }: UsageModalProps) {
  const [days, setDays] = useState(7);
  const [rawData, setRawData] = useState<UsageData | null>(null);
  const [fetchedDays, setFetchedDays] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const data = rawData && days <= fetchedDays ? filterToRange(rawData, days) : rawData;

  const fetchUsage = useCallback(async (numDays: number) => {
    setLoading(true);
    setError('');
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
        setRawData(json as UsageData);
        setFetchedDays(numDays);
      }
    } catch (e: any) {
      setError(e.message ?? 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchedDays > 0 && days <= fetchedDays) return; // already covered by cached data
    fetchUsage(days);
  }, [days, fetchedDays, fetchUsage]);

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
            <div className="usage-loading">
              <span className="spinner" /> Loading usage data...
            </div>
          )}
          {error && (
            <div className="usage-error">{error}</div>
          )}
          {!loading && !error && data && (
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Models</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cache Write</th>
                  <th>Cache Read</th>
                  <th>Total Tokens</th>
                  <th>Claude</th>
                  {data.codex && <th className="cost-codex">Codex</th>}
                  {data.codex && <th>Total</th>}
                </tr>
              </thead>
              <tbody>
                {data.daily.map((entry) => {
                  const codexEntry = data.codex?.daily.find(c => c.date === entry.date);
                  const codexCost = codexEntry?.costUSD ?? 0;
                  const total = entry.totalCost + codexCost;
                  return (
                    <tr key={entry.date}>
                      <td>{entry.date}</td>
                      <td>{entry.modelsUsed.map(shortModel).join(', ')}</td>
                      <td>{fmt(entry.inputTokens)}</td>
                      <td>{fmt(entry.outputTokens)}</td>
                      <td>{fmt(entry.cacheCreationTokens)}</td>
                      <td>{fmt(entry.cacheReadTokens)}</td>
                      <td>{fmt(entry.totalTokens)}</td>
                      <td className="cost-claude">{fmtCost(entry.totalCost)}</td>
                      {data.codex && <td className={codexCost > 0 ? 'cost-codex' : ''}>{fmtCost(codexCost)}</td>}
                      {data.codex && <td className="cost-total">{fmtCost(total)}</td>}
                    </tr>
                  );
                })}
                {data.daily.length === 0 && (
                  <tr>
                    <td colSpan={data.codex ? 10 : 8} className="usage-empty">
                      No usage data for this period.
                    </td>
                  </tr>
                )}
              </tbody>
              {data.totals && data.daily.length > 1 && (
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td />
                    <td>{fmt(data.totals.inputTokens)}</td>
                    <td>{fmt(data.totals.outputTokens)}</td>
                    <td>{fmt(data.totals.cacheCreationTokens)}</td>
                    <td>{fmt(data.totals.cacheReadTokens)}</td>
                    <td>{fmt(data.totals.totalTokens)}</td>
                    <td className="cost-claude">{fmtCost(data.totals.totalCost)}</td>
                    {data.codex && (
                      <td className="cost-codex">{fmtCost(data.codex.totals?.costUSD ?? 0)}</td>
                    )}
                    {data.codex && (
                      <td className="cost-total">{fmtCost(data.totals.totalCost + (data.codex.totals?.costUSD ?? 0))}</td>
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          {!loading && !error && !data && (
            <div className="usage-loading" style={{ fontStyle: 'italic' }}>
              No usage data found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
