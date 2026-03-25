import React, { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

type Decision = 'ignored' | 'debated' | 'ran';

interface EyeEvent {
  ts: number;
  event_type: string;
  action: string;
  repo: string;
  author: string;
  decision: Decision;
  job_title: string | null;
  detail: string | null;
}

interface EyeStatus {
  uptime_ms: number;
  events_received: number;
  jobs_created: number;
  dedup: { size: number };
  recent_events: EyeEvent[];
  config: {
    author: string;
    orchestratorUrl: string;
  };
}

interface TemplateFilter {
  field: string;
  op: 'eq' | 'neq';
  value: string;
}

interface DebateBindingConfig {
  claudeModel?: string;
  codexModel?: string;
  maxRounds?: number;
  postActionVerification?: boolean;
  postActionPrompt?: string;
  postActionRole?: 'claude' | 'codex';
  completionChecks?: string[];
}

interface TemplateBinding {
  templateId: string;
  filters: TemplateFilter[];
  mode?: 'job' | 'debate' | 'auto';
  debateConfig?: DebateBindingConfig;
}

interface EyeSettings {
  webhookSecret: string;
  author: string;
  port: number;
  eventTemplates: Record<string, TemplateBinding[]>;
  disabledEvents: string[];
}

interface Template {
  id: string;
  name: string;
}

/** Available filter fields per event type */
type FilterFieldDef = { field: string; label: string; values: { value: string; label: string }[] };

const COMMON_FILTERS: FilterFieldDef[] = [
  { field: 'pr_draft', label: 'PR State', values: [{ value: 'true', label: 'Draft' }, { value: 'false', label: 'Published' }] },
  { field: 'pr_author_is_self', label: 'PR Author', values: [{ value: 'true', label: 'Self' }, { value: 'false', label: 'Others' }] },
  { field: 'sender_is_self', label: 'Sender', values: [{ value: 'true', label: 'Self' }, { value: 'false', label: 'Others' }] },
  { field: 'is_bot', label: 'Bot Message', values: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  { field: 'pr_state', label: 'PR Open State', values: [{ value: 'open', label: 'Open' }, { value: 'merged', label: 'Merged' }, { value: 'closed', label: 'Closed' }] },
];

const FILTER_FIELDS: Record<string, FilterFieldDef[]> = {
  check_suite: [
    ...COMMON_FILTERS,
    { field: 'check_conclusion', label: 'Conclusion', values: [{ value: 'failure', label: 'Failure' }, { value: 'success', label: 'Success' }, { value: 'neutral', label: 'Neutral' }] },
  ],
  check_run: [
    ...COMMON_FILTERS,
    { field: 'check_conclusion', label: 'Conclusion', values: [{ value: 'failure', label: 'Failure' }, { value: 'success', label: 'Success' }, { value: 'neutral', label: 'Neutral' }] },
  ],
  pull_request_review: [
    ...COMMON_FILTERS,
    { field: 'review_state', label: 'Review Type', values: [{ value: 'changes_requested', label: 'Changes Requested' }, { value: 'commented', label: 'Commented' }, { value: 'approved', label: 'Approved' }] },
    { field: 'review_has_body', label: 'Has Body', values: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
  ],
  issue_comment: [
    ...COMMON_FILTERS,
  ],
};

const EVENT_TYPES: { key: string; label: string; description: string }[] = [
  { key: 'check_suite', label: 'CI Suites', description: 'Check suite failures' },
  { key: 'check_run', label: 'CI Checks', description: 'Individual check run failures' },
  { key: 'pull_request_review', label: 'PR Reviews', description: 'Review comments and change requests' },
  { key: 'issue_comment', label: 'PR Comments', description: 'Comments on pull requests' },
];

interface EyeApiState {
  settings: EyeSettings;
  running: boolean;
  pid: number | null;
}

interface EyeModalProps {
  onClose: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function eventIcon(eventType: string): string {
  switch (eventType) {
    case 'check_suite':
    case 'check_run':
      return 'CI';
    case 'pull_request_review':
      return 'Rev';
    case 'issue_comment':
      return 'Cmt';
    case 'pull_request':
      return 'PR';
    default:
      return '?';
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EyeModal({ onClose }: EyeModalProps) {
  // Eye process status (polled from the eye service directly)
  const [eyeStatus, setEyeStatus] = useState<EyeStatus | null>(null);
  const [eyeConnected, setEyeConnected] = useState<boolean | null>(null);

  // Server-managed config + process state
  const [apiState, setApiState] = useState<EyeApiState | null>(null);

  // Local form state
  const [webhookSecret, setWebhookSecret] = useState('');
  const [author, setAuthor] = useState('');
  const [port, setPort] = useState(4567);
  const [eventTemplates, setEventTemplates] = useState<Record<string, TemplateBinding[]>>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [disabledEvents, setDisabledEvents] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<string, boolean>>({});

  // Action state
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState('');
  const [configDirty, setConfigDirty] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  // ─── Fetch eye service status (proxied through orchestrator) ──────────

  const fetchEyeStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/status');
      if (!res.ok) {
        setEyeConnected(false);
        return;
      }
      const data = await res.json() as EyeStatus;
      setEyeStatus(data);
      setEyeConnected(true);
    } catch {
      setEyeConnected(false);
      setEyeStatus(null);
    }
  }, []);

  // ─── Fetch server-side config + process state ───────────────────────────

  const fetchApiState = useCallback(async () => {
    try {
      const res = await fetch('/api/eye');
      if (!res.ok) return;
      const data = await res.json() as EyeApiState;
      setApiState(data);
      return data;
    } catch {
      // Server unreachable
    }
    return null;
  }, []);

  // ─── Init ───────────────────────────────────────────────────────────────

  useEffect(() => {
    // Load config from server
    fetchApiState().then(state => {
      if (state) {
        setWebhookSecret(state.settings.webhookSecret);
        setAuthor(state.settings.author);
        setPort(state.settings.port || 4567);
        setEventTemplates(state.settings.eventTemplates ?? {});
        setDisabledEvents(state.settings.disabledEvents ?? []);
      }
    });
    // Fetch available templates
    fetch('/api/templates').then(res => res.ok ? res.json() : []).then(
      (data: Template[]) => setTemplates(data)
    ).catch(() => {});
    // Poll eye status
    fetchEyeStatus();
    intervalRef.current = setInterval(() => {
      fetchEyeStatus();
      fetchApiState();
    }, 5000);
    return () => clearInterval(intervalRef.current);
  }, [fetchEyeStatus, fetchApiState]);

  // ─── Track dirty state ──────────────────────────────────────────────────

  useEffect(() => {
    if (!apiState) return;
    const s = apiState.settings;
    setConfigDirty(
      webhookSecret !== s.webhookSecret ||
      author !== s.author ||
      port !== s.port ||
      JSON.stringify(eventTemplates) !== JSON.stringify(s.eventTemplates ?? {}) ||
      JSON.stringify(disabledEvents) !== JSON.stringify(s.disabledEvents ?? [])
    );
  }, [apiState, webhookSecret, author, port, eventTemplates, disabledEvents]);

  // ─── Actions ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setActionError('');
    try {
      const res = await fetch('/api/eye', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookSecret, author, port, eventTemplates, disabledEvents }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? 'Failed to save');
        return;
      }
      await fetchApiState();
      setConfigDirty(false);
    } catch (e: any) {
      setActionError(e.message ?? 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleLaunch = async () => {
    // Save first if dirty
    if (configDirty) {
      await handleSave();
    }
    setLaunching(true);
    setActionError('');
    try {
      const res = await fetch('/api/eye/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error ?? 'Failed to start');
        return;
      }
      // Wait a moment for the process to start, then refresh
      setTimeout(() => {
        fetchEyeStatus();
        fetchApiState();
        setLaunching(false);
      }, 2000);
    } catch (e: any) {
      setActionError(e.message ?? 'Network error');
      setLaunching(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setActionError('');
    try {
      const res = await fetch('/api/eye/stop', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setActionError(data.error ?? 'Failed to stop');
        return;
      }
      setTimeout(() => {
        fetchEyeStatus();
        fetchApiState();
        setStopping(false);
      }, 1500);
    } catch (e: any) {
      setActionError(e.message ?? 'Network error');
      setStopping(false);
    }
  };

  const [hideIgnored, setHideIgnored] = useState(false);

  // ─── Derived ────────────────────────────────────────────────────────────

  const isRunning = eyeConnected === true;
  const allEvents = eyeStatus?.recent_events ? [...eyeStatus.recent_events].reverse() : [];
  const events = hideIgnored ? allEvents.filter(ev => ev.decision !== 'ignored') : allEvents;
  const ignoredCount = allEvents.length - allEvents.filter(ev => ev.decision !== 'ignored').length;
  const canLaunch = !!webhookSecret && !!author;

  return (
    <div className="modal-overlay" onClick={onClose} onKeyDown={e => e.key === 'Escape' && onClose()}>
      <div
        className="modal"
        onClick={e => e.stopPropagation()}
        style={{ width: '90vw', maxWidth: 840 }}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2>Eye</h2>
            <span className={`eye-status-dot ${isRunning ? 'eye-status-dot--on' : eyeConnected === false ? 'eye-status-dot--off' : ''}`} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {eyeConnected === null ? 'Checking...' : isRunning ? 'Running' : 'Offline'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isRunning && (
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)' }}
                onClick={handleStop}
                disabled={stopping}
              >
                {stopping ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <button className="btn-icon" onClick={onClose} aria-label="Close">&#x2715;</button>
          </div>
        </div>

        {/* Running: stats + events */}
        {isRunning && eyeStatus && (
          <>
            <div className="eye-stats-row">
              <div className="eye-stat">
                <div className="eye-stat-value">{formatUptime(eyeStatus.uptime_ms)}</div>
                <div className="eye-stat-label">Uptime</div>
              </div>
              <div className="eye-stat">
                <div className="eye-stat-value">{eyeStatus.events_received}</div>
                <div className="eye-stat-label">Events</div>
              </div>
              <div className="eye-stat">
                <div className="eye-stat-value">{eyeStatus.jobs_created}</div>
                <div className="eye-stat-label">Jobs Created</div>
              </div>
              <div className="eye-stat">
                <div className="eye-stat-value">{eyeStatus.dedup.size}</div>
                <div className="eye-stat-label">Dedup Entries</div>
              </div>
            </div>

            <div className="eye-config-bar">
              <span>
                <span className="eye-config-label">Author</span>
                <span className="eye-config-tag">{eyeStatus.config.author}</span>
              </span>
              {apiState?.settings?.disabledEvents && apiState.settings.disabledEvents.length > 0 && (
                <span>
                  <span className="eye-config-label">Disabled</span>
                  {apiState.settings.disabledEvents.map(e => (
                    <span key={e} className="eye-config-tag" style={{ color: 'var(--text-dim)' }}>
                      {EVENT_TYPES.find(et => et.key === e)?.label ?? e}
                    </span>
                  ))}
                </span>
              )}
            </div>

            {apiState?.settings?.eventTemplates && Object.keys(apiState.settings.eventTemplates).length > 0 && (
              <div className="eye-prompts-display" style={{ padding: '8px 12px', margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Templates:</div>
                {Object.entries(apiState.settings.eventTemplates).map(([eventKey, bindings]) => {
                  const eventLabel = EVENT_TYPES.find(et => et.key === eventKey)?.label ?? eventKey;
                  return (
                    <div key={eventKey} style={{ marginLeft: 8, marginBottom: 2 }}>
                      <span style={{ color: 'var(--text-dim)' }}>{eventLabel}:</span>{' '}
                      {bindings.map((b, i) => {
                        const name = templates.find(t => t.id === b.templateId)?.name ?? b.templateId;
                        const filterDesc = b.filters.length > 0
                          ? ` (${b.filters.map(f => `${f.field} ${f.op} ${f.value}`).join(', ')})`
                          : '';
                        const modeTag = b.mode === 'debate' ? ' [debate]' : b.mode === 'job' ? ' [job]' : '';
                        return <span key={i}>{i > 0 ? ', ' : ''}{name}{modeTag}{filterDesc}</span>;
                      })}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="eye-events-section">
              <div className="eye-events-header">
                <span>
                  Events
                  <span className="eye-events-count">{events.length}</span>
                </span>
                {ignoredCount > 0 && (
                  <label className="eye-hide-ignored-toggle">
                    <input
                      type="checkbox"
                      checked={hideIgnored}
                      onChange={e => setHideIgnored(e.target.checked)}
                    />
                    Hide ignored ({ignoredCount})
                  </label>
                )}
              </div>
              <div className="eye-events-list">
                {events.length === 0 && (
                  <div className="eye-events-empty">No events received yet. Waiting for webhooks...</div>
                )}
                {events.map((ev, i) => (
                  <div key={`${ev.ts}-${i}`} className={`eye-event eye-event--${ev.decision}`}>
                    <span className="eye-event-time">{formatTime(ev.ts)}</span>
                    <span className={`eye-event-type eye-event-type--${ev.event_type.replace(/_/g, '-')}`} title={ev.event_type}>
                      {eventIcon(ev.event_type)}
                    </span>
                    {ev.author && <span className="eye-event-author">{ev.author}</span>}
                    <span className="eye-event-body">
                      {ev.decision === 'ran' && (
                        <>
                          <span className="eye-event-decision eye-event-decision--ran">ran</span>
                          {' '}{ev.job_title}
                        </>
                      )}
                      {ev.decision === 'debated' && (
                        <>
                          <span className="eye-event-decision eye-event-decision--debated">debated</span>
                          {' '}{ev.job_title}
                        </>
                      )}
                      {ev.decision === 'ignored' && (
                        <>
                          <span className="eye-event-decision eye-event-decision--ignored">ignored</span>
                          {' '}{ev.detail}
                          {ev.repo && <span className="eye-event-repo"> on {ev.repo}</span>}
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Loading state */}
        {eyeConnected === null && (
          <div className="usage-loading">
            <span className="spinner" /> Connecting to Eye...
          </div>
        )}

        {/* Config form (always shown when not running) */}
        {!isRunning && eyeConnected !== null && (
          <div className="eye-config-form">
            <div className="eye-config-form-grid">
              <div className="form-group">
                <label>Webhook Secret <span style={{ color: 'var(--danger)' }}>*</span></label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={webhookSecret}
                    onChange={e => setWebhookSecret(e.target.value)}
                    placeholder="GitHub webhook secret"
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => setShowSecret(!showSecret)}
                    type="button"
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {showSecret ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div className="eye-config-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label>Author <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input
                    type="text"
                    value={author}
                    onChange={e => setAuthor(e.target.value)}
                    placeholder="GitHub username"
                  />
                  <div className="eye-field-hint">Your GitHub username (to filter PRs)</div>
                </div>
                <div className="form-group" style={{ flex: '0 0 100px' }}>
                  <label>Port</label>
                  <input
                    type="number"
                    value={port}
                    onChange={e => setPort(Number(e.target.value))}
                    min={1024}
                    max={65535}
                    style={{ width: 90 }}
                  />
                </div>
              </div>
            </div>

            <div className="form-group" style={{ marginTop: 12 }}>
              <label>Events</label>
              <div className="eye-event-list">
                {EVENT_TYPES.map(et => {
                  const enabled = !disabledEvents.includes(et.key);
                  const expanded = expandedEvents[et.key] ?? false;
                  const bindings = eventTemplates[et.key] ?? [];
                  const bindingCount = bindings.length;
                  const filterFields = FILTER_FIELDS[et.key] ?? [];
                  return (
                    <div key={et.key} className={`eye-event-row ${enabled ? '' : 'eye-event-row--off'}`}>
                      <div className="eye-event-row-header">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => {
                            setDisabledEvents(prev =>
                              prev.includes(et.key)
                                ? prev.filter(k => k !== et.key)
                                : [...prev, et.key]
                            );
                          }}
                        />
                        <div className="eye-event-row-info">
                          <span className="eye-event-row-label">{et.label}</span>
                          <span className="eye-event-row-desc">{et.description}</span>
                        </div>
                        {enabled && (
                          <button
                            className="eye-event-row-toggle"
                            onClick={() => setExpandedEvents(prev => ({ ...prev, [et.key]: !expanded }))}
                            type="button"
                          >
                            {bindingCount === 0 ? 'No templates' : `${bindingCount} template${bindingCount > 1 ? 's' : ''}`}
                            <span className={`eye-event-row-chevron ${expanded ? 'eye-event-row-chevron--open' : ''}`}>&#x25B8;</span>
                          </button>
                        )}
                      </div>
                      {enabled && expanded && (
                        <div className="eye-event-row-body">
                          {bindings.length > 0 && (
                            <div className="eye-event-template-list">
                              {bindings.map((binding, idx) => {
                                const tpl = templates.find(t => t.id === binding.templateId);
                                return (
                                  <div key={idx} className="eye-event-binding">
                                    <div className="eye-event-template-item">
                                      <span className="eye-event-template-name">{tpl?.name ?? binding.templateId}</span>
                                      <select
                                        className="eye-binding-mode"
                                        value={binding.mode ?? 'auto'}
                                        onChange={e => {
                                          const mode = e.target.value as 'job' | 'debate' | 'auto';
                                          setEventTemplates(prev => {
                                            const next = { ...prev };
                                            const b = { ...next[et.key][idx], mode };
                                            if (mode === 'debate' && !b.debateConfig) {
                                              b.debateConfig = { postActionVerification: true };
                                            }
                                            next[et.key] = [...next[et.key]];
                                            next[et.key][idx] = b;
                                            return next;
                                          });
                                        }}
                                        title="Dispatch mode"
                                      >
                                        <option value="auto">Auto</option>
                                        <option value="job">Job</option>
                                        <option value="debate">Debate</option>
                                      </select>
                                      <button
                                        className="eye-event-template-remove"
                                        type="button"
                                        onClick={() => {
                                          setEventTemplates(prev => {
                                            const next = { ...prev };
                                            next[et.key] = (next[et.key] ?? []).filter((_, i) => i !== idx);
                                            if (next[et.key].length === 0) delete next[et.key];
                                            return next;
                                          });
                                        }}
                                        title="Remove template"
                                      >
                                        &#x2715;
                                      </button>
                                    </div>
                                    {/* Debate config (shown when mode is debate) */}
                                    {(binding.mode === 'debate') && (
                                      <div className="eye-debate-config">
                                        <div className="eye-debate-config-row">
                                          <label>
                                            Side A
                                            <input
                                              type="text"
                                              value={binding.debateConfig?.claudeModel ?? 'sonnet'}
                                              onChange={e => {
                                                setEventTemplates(prev => {
                                                  const next = { ...prev };
                                                  const b = { ...next[et.key][idx] };
                                                  b.debateConfig = { ...b.debateConfig, claudeModel: e.target.value };
                                                  next[et.key] = [...next[et.key]];
                                                  next[et.key][idx] = b;
                                                  return next;
                                                });
                                              }}
                                              placeholder="sonnet"
                                            />
                                          </label>
                                          <label>
                                            Side B
                                            <input
                                              type="text"
                                              value={binding.debateConfig?.codexModel ?? 'codex'}
                                              onChange={e => {
                                                setEventTemplates(prev => {
                                                  const next = { ...prev };
                                                  const b = { ...next[et.key][idx] };
                                                  b.debateConfig = { ...b.debateConfig, codexModel: e.target.value };
                                                  next[et.key] = [...next[et.key]];
                                                  next[et.key][idx] = b;
                                                  return next;
                                                });
                                              }}
                                              placeholder="codex"
                                            />
                                          </label>
                                          <label>
                                            Rounds
                                            <input
                                              type="number"
                                              value={binding.debateConfig?.maxRounds ?? 3}
                                              min={1}
                                              max={10}
                                              onChange={e => {
                                                setEventTemplates(prev => {
                                                  const next = { ...prev };
                                                  const b = { ...next[et.key][idx] };
                                                  b.debateConfig = { ...b.debateConfig, maxRounds: Number(e.target.value) };
                                                  next[et.key] = [...next[et.key]];
                                                  next[et.key][idx] = b;
                                                  return next;
                                                });
                                              }}
                                              style={{ width: 50 }}
                                            />
                                          </label>
                                        </div>
                                        <label className="eye-debate-config-check">
                                          <input
                                            type="checkbox"
                                            checked={binding.debateConfig?.postActionVerification ?? true}
                                            onChange={e => {
                                              setEventTemplates(prev => {
                                                const next = { ...prev };
                                                const b = { ...next[et.key][idx] };
                                                b.debateConfig = { ...b.debateConfig, postActionVerification: e.target.checked };
                                                next[et.key] = [...next[et.key]];
                                                next[et.key][idx] = b;
                                                return next;
                                              });
                                            }}
                                          />
                                          Post-action verification (reviewer checks implementation)
                                        </label>
                                      </div>
                                    )}
                                    {/* Filter tags */}
                                    {binding.filters.length > 0 && (
                                      <div className="eye-filter-tags">
                                        {binding.filters.map((f, fi) => {
                                          const fieldDef = filterFields.find(ff => ff.field === f.field);
                                          const valDef = fieldDef?.values.find(v => v.value === f.value);
                                          return (
                                            <span key={fi} className="eye-filter-tag">
                                              {fieldDef?.label ?? f.field} {f.op === 'eq' ? '=' : '\u2260'} {valDef?.label ?? f.value}
                                              <button
                                                className="eye-filter-tag-remove"
                                                type="button"
                                                onClick={() => {
                                                  setEventTemplates(prev => {
                                                    const next = { ...prev };
                                                    const b = { ...next[et.key][idx] };
                                                    b.filters = b.filters.filter((_, i) => i !== fi);
                                                    next[et.key] = [...next[et.key]];
                                                    next[et.key][idx] = b;
                                                    return next;
                                                  });
                                                }}
                                              >
                                                &#x2715;
                                              </button>
                                            </span>
                                          );
                                        })}
                                      </div>
                                    )}
                                    {/* Add filter */}
                                    {filterFields.length > 0 && (
                                      <select
                                        className="eye-filter-add"
                                        value=""
                                        onChange={e => {
                                          const raw = e.target.value;
                                          if (!raw) return;
                                          let op: 'eq' | 'neq' = 'eq';
                                          let rest = raw;
                                          if (raw.startsWith('neq:')) {
                                            op = 'neq';
                                            rest = raw.slice(4);
                                          }
                                          const colonIdx = rest.indexOf(':');
                                          const field = rest.slice(0, colonIdx);
                                          const fval = rest.slice(colonIdx + 1);
                                          setEventTemplates(prev => {
                                            const next = { ...prev };
                                            const b = { ...next[et.key][idx] };
                                            b.filters = [...b.filters, { field, op, value: fval }];
                                            next[et.key] = [...next[et.key]];
                                            next[et.key][idx] = b;
                                            return next;
                                          });
                                        }}
                                      >
                                        <option value="">Add filter...</option>
                                        {filterFields.map(ff =>
                                          ff.values.map(v => (
                                            <option key={`${ff.field}:${v.value}`} value={`${ff.field}:${v.value}`}>
                                              {ff.label} = {v.label}
                                            </option>
                                          ))
                                        )}
                                        {filterFields.map(ff =>
                                          ff.values.map(v => (
                                            <option key={`neq:${ff.field}:${v.value}`} value={`neq:${ff.field}:${v.value}`}>
                                              {ff.label} &ne; {v.label}
                                            </option>
                                          ))
                                        )}
                                      </select>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {templates.length > 0 && (
                            <select
                              value=""
                              onChange={e => {
                                const val = e.target.value;
                                if (!val) return;
                                setEventTemplates(prev => ({
                                  ...prev,
                                  [et.key]: [...(prev[et.key] ?? []), {
                                    templateId: val,
                                    filters: [
                                      { field: 'pr_author_is_self', op: 'eq' as const, value: 'true' },
                                      { field: 'is_bot', op: 'eq' as const, value: 'false' },
                                    ],
                                  }],
                                }));
                              }}
                              style={{ width: '100%', fontSize: 12 }}
                            >
                              <option value="">Add template...</option>
                              {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {actionError && (
              <div className="eye-action-error">{actionError}</div>
            )}

            <div className="eye-config-actions">
              {configDirty && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={handleLaunch}
                disabled={launching || !canLaunch}
                title={canLaunch ? 'Start the Eye webhook listener' : 'Fill in all required fields first'}
              >
                {launching ? 'Launching...' : 'Launch Eye'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
