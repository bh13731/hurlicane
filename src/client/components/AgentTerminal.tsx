import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import socket from '../socket';
import { QuestionBubble } from './QuestionBubble';
import { DiffViewer } from './DiffViewer';
import type { AgentWithJob, AgentOutput, AgentOutputSegment, ClaudeStreamEvent, ChildAgentSummary } from '@shared/types';

interface AgentTerminalProps {
  agent: AgentWithJob;
  onClose: () => void;
  onContinued?: (newAgent: AgentWithJob) => void;
}

function renderEvent(event: ClaudeStreamEvent): string {
  switch (event.type) {
    case 'system': {
      const modelInfo = event.model ? ` | ${event.model}` : '';
      return `\x1b[36m[${event.subtype ?? 'system'}${modelInfo}]\x1b[0m\r\n`;
    }
    case 'assistant': {
      const content = event.message?.content ?? [];
      let out = '';
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out += `\r\n${block.text}\r\n`;
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? JSON.stringify(block.input) : '';
          const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
          out += `\r\n\x1b[2m⚙ ${block.name}`;
          if (preview && preview !== '{}') out += `(${preview})`;
          out += `\x1b[0m\r\n`;
        }
      }
      return out;
    }
    case 'result': {
      if (event.is_error) {
        return `\r\n\x1b[31m✗ ${event.result || 'error'}\x1b[0m\r\n`;
      }
      return `\r\n\x1b[32m✓ Done\x1b[0m\r\n`;
    }
    case 'error':
      return `\x1b[31m✗ ${event.error?.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

function RetryButton({ agentId, onRetried }: { agentId: string; onRetried: (a: AgentWithJob) => void }) {
  const [loading, setLoading] = useState(false);

  const handleRetry = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/retry`, { method: 'POST' });
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
        <button className="btn btn-secondary btn-sm" onClick={handleRetry} disabled={loading}>
          {loading ? '…' : '↺ Retry'}
        </button>
      </div>
    </div>
  );
}

function CancelButton({ agentId, onCancelled }: { agentId: string; onCancelled: () => void }) {
  const [loading, setLoading] = useState(false);

  const handleCancel = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/cancel`, { method: 'POST' });
      if (res.ok) onCancelled();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button className="btn btn-danger btn-sm" onClick={handleCancel} disabled={loading}>
      {loading ? '…' : '◻ Cancel'}
    </button>
  );
}

function ContinueInput({ agentId, onContinued }: { agentId: string; onContinued: (a: AgentWithJob) => void }) {
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msg.trim() || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg.trim() }),
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
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !msg.trim()}>
          {loading ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

export function AgentTerminal({ agent, onClose, onContinued }: AgentTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const viewStartRef = useRef<number>(Date.now());
  const [childAgents, setChildAgents] = useState<ChildAgentSummary[]>(agent.child_agents ?? []);
  const [activeTab, setActiveTab] = useState<'output' | 'changes'>('output');
  const [diff, setDiff] = useState<string | null>((agent as any).diff ?? null);
  const [baseSha, setBaseSha] = useState<string | null>((agent as any).base_sha ?? null);
  const [diffFetched, setDiffFetched] = useState(false);

  // Reset the view-start timestamp and child agents whenever we switch to a different agent
  useEffect(() => {
    viewStartRef.current = Date.now();
    setChildAgents(agent.child_agents ?? []);
    setActiveTab('output');
    setDiff((agent as any).diff ?? null);
    setBaseSha((agent as any).base_sha ?? null);
    setDiffFetched(false);
  }, [agent.id]);

  // Keep child agents up-to-date via socket events
  useEffect(() => {
    const newHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      if (a.parent_agent_id === agent.id) {
        setChildAgents(prev => {
          if (prev.some(c => c.id === a.id)) return prev;
          return [...prev, { id: a.id, status: a.status, job_title: a.job.title, job_description: a.job.description }];
        });
      }
    };
    const updateHandler = ({ agent: a }: { agent: AgentWithJob }) => {
      setChildAgents(prev => prev.map(c => c.id === a.id ? { ...c, status: a.status } : c));
    };
    socket.on('agent:new', newHandler);
    socket.on('agent:update', updateHandler);
    return () => {
      socket.off('agent:new', newHandler);
      socket.off('agent:update', updateHandler);
    };
  }, [agent.id]);

  // Mark as read only once the agent has reached a terminal state AND the terminal has been
  // open for at least 2 seconds — prevents marking running continuation agents as read
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status) || agent.output_read !== 0) return;
    const delay = Math.max(0, 2000 - (Date.now() - viewStartRef.current));
    const timer = setTimeout(() => {
      fetch(`/api/agents/${agent.id}/read`, { method: 'POST' }).catch(console.error);
    }, delay);
    return () => clearTimeout(timer);
  }, [agent.id, agent.status, agent.output_read]);

  // Fetch diff when agent completes (once per agent)
  useEffect(() => {
    const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
    if (!TERMINAL_STATUSES.includes(agent.status)) return;
    if (diffFetched) return;
    setDiffFetched(true);
    fetch(`/api/agents/${agent.id}/diff`)
      .then(r => r.json())
      .then(d => {
        setBaseSha(d.base_sha ?? null);
        setDiff(d.diff ?? null);
      })
      .catch(() => {});
  }, [agent.id, agent.status]);

  const isInteractive = !!(agent.job as any).is_interactive;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      convertEol: !isInteractive,
      scrollback: 50000,
      cursorBlink: isInteractive,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Delay fit to ensure layout is ready
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    termRef.current = term;

    if (isInteractive) {
      // Interactive mode: raw PTY data from tmux session

      // Disable input forwarding until history replay is complete — replaying raw PTY
      // history causes xterm.js to process escape sequences (e.g. DA2 queries) and
      // auto-generate terminal responses via onData, which would be forwarded to the
      // live PTY at the wrong time and appear as literal text in Claude's input field.
      let inputEnabled = false;

      // Buffer live pty:data events until history is loaded to prevent race condition
      // where new data gets written before the history, causing jumbled output.
      let historyLoaded = false;
      const pendingPtyData: string[] = [];

      const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'];
      fetch(`/api/agents/${agent.id}/pty-history`)
        .then(r => r.json())
        .then(({ chunks }: { chunks: string[] }) => {
          if (chunks.length > 0) {
            // For completed sessions, strip alternate-screen entry/exit sequences
            // (\e[?1049h / \e[?1049l and older variants).  Claude's TUI runs in
            // the alternate screen, which has no scrollback.  By removing those
            // control sequences during replay we keep all content in the main
            // screen's scrollback buffer so the user can scroll up to see the
            // full session history.  We leave them intact for live (running)
            // sessions so interactive use works normally.
            const isCompleted = TERMINAL_STATUSES.includes(agent.status);
            const ALT_SCREEN_RE = /\x1b\[\?(?:1049|47|1047)[hl]/g;
            for (const chunk of chunks) {
              term.write(isCompleted ? chunk.replace(ALT_SCREEN_RE, '') : chunk);
            }
          }
          // Flush any live data that arrived during the fetch
          for (const data of pendingPtyData) term.write(data);
          pendingPtyData.length = 0;
          historyLoaded = true;
          inputEnabled = true;
          if (TERMINAL_STATUSES.includes(agent.status)) {
            term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
          } else {
            term.focus();
          }
        })
        .catch(() => {
          // Still flush any pending data
          for (const data of pendingPtyData) term.write(data);
          pendingPtyData.length = 0;
          historyLoaded = true;
          inputEnabled = true;
          if (TERMINAL_STATUSES.includes(agent.status)) {
            term.write('\r\n\x1b[2m[session ended — no history available]\x1b[0m\r\n');
          } else {
            term.focus();
          }
        });

      const ptyDataHandler = ({ agent_id, data }: { agent_id: string; data: string }) => {
        if (agent_id !== agent.id) return;
        if (!historyLoaded) {
          pendingPtyData.push(data);
          return;
        }
        term.write(data);
      };
      const ptyClosedHandler = ({ agent_id }: { agent_id: string }) => {
        if (agent_id !== agent.id) return;
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      };
      socket.on('pty:data', ptyDataHandler);
      socket.on('pty:closed', ptyClosedHandler);

      // Forward keyboard input — skip while history is replaying, and filter out
      // DA1/DA2 device-attribute responses that xterm.js generates automatically
      // (ESC[>params c / ESC[?params c); these must not reach Claude's input field.
      const inputDispose = term.onData((data) => {
        if (!inputEnabled) return;
        if (/^\x1b\[[\?>][0-9;]*c$/.test(data)) return;
        socket.emit('pty:input', { agent_id: agent.id, data });
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          socket.emit('pty:resize', { agent_id: agent.id, cols: term.cols, rows: term.rows });
        } catch { /* ignore */ }
      });
      if (containerRef.current) resizeObserver.observe(containerRef.current);

      return () => {
        socket.off('pty:data', ptyDataHandler);
        socket.off('pty:closed', ptyClosedHandler);
        inputDispose.dispose();
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
      };
    } else {
      // Batch mode: stream-json rendering
      // Load historical output (full ancestry chain for continuations)
      fetch(`/api/agents/${agent.id}/full-output`)
        .then(r => r.json())
        .then((segments: AgentOutputSegment[]) => {
          for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (i > 0) {
              // Separator between prior run and continuation
              term.write(`\r\n\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n`);
              term.write(`\x1b[2m↩ ${seg.job_description}\x1b[0m\r\n`);
              term.write(`\x1b[2m\x1b[36m${'─'.repeat(40)}\x1b[0m\r\n\r\n`);
            }
            for (const line of seg.output) {
              try {
                const event: ClaudeStreamEvent = JSON.parse(line.content);
                const rendered = renderEvent(event);
                if (rendered) term.write(rendered);
              } catch {
                term.write(line.content + '\r\n');
              }
            }
          }
        })
        .catch(console.error);

      // Stream live output
      const outputHandler = ({ agent_id, line }: { agent_id: string; line: AgentOutput }) => {
        if (agent_id !== agent.id) return;
        try {
          const event: ClaudeStreamEvent = JSON.parse(line.content);
          const rendered = renderEvent(event);
          if (rendered) term.write(rendered);
        } catch {
          term.write(line.content + '\r\n');
        }
      };

      socket.on('agent:output', outputHandler);

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });
      if (containerRef.current) resizeObserver.observe(containerRef.current);

      return () => {
        socket.off('agent:output', outputHandler);
        resizeObserver.disconnect();
        term.dispose();
        termRef.current = null;
      };
    }
  }, [agent.id]);

  const contextEntries: [string, string][] = (() => {
    try {
      const parsed = agent.job.context ? JSON.parse(agent.job.context) : null;
      return parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
    } catch { return []; }
  })();

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-header-info">
          <span className="terminal-agent-id">Agent {agent.id.slice(0, 6)}</span>
          <span className="terminal-job-title">{agent.job.title}</span>
        </div>
        <div className="terminal-header-actions">
          {isInteractive && (agent.status === 'running' || agent.status === 'starting') && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => fetch(`/api/agents/${agent.id}/disconnect`, { method: 'DELETE' })}
            >
              Disconnect
            </button>
          )}
          {!isInteractive && ['starting', 'running', 'waiting_user'].includes(agent.status) && (
            <CancelButton agentId={agent.id} onCancelled={onClose} />
          )}
          <button
            className={`flag-btn${agent.job.flagged ? ' flag-btn-active' : ''}`}
            onClick={() => fetch(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' })}
            title={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
            style={{ fontSize: '16px' }}
          >
            ⚑
          </button>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="job-request-section">
        <div className="job-request-label">Request</div>
        <div className="job-request-description">{agent.job.description}</div>
        {(agent.cost_usd != null || agent.duration_ms != null || agent.num_turns != null) && (
          <div className="agent-run-stats">
            {agent.cost_usd != null && (
              <span className="agent-stat" title="Total cost">
                💰 ${agent.cost_usd.toFixed(4)}
              </span>
            )}
            {agent.duration_ms != null && (
              <span className="agent-stat" title="Runtime">
                ⏱ {agent.duration_ms >= 60000
                  ? `${Math.floor(agent.duration_ms / 60000)}m ${Math.round((agent.duration_ms % 60000) / 1000)}s`
                  : `${(agent.duration_ms / 1000).toFixed(1)}s`}
              </span>
            )}
            {agent.num_turns != null && (
              <span className="agent-stat" title="Number of turns">
                ↩ {agent.num_turns} turns
              </span>
            )}
          </div>
        )}
        {contextEntries.length > 0 && (
          <div className="job-request-context">
            {contextEntries.map(([k, v]) => (
              <div key={k} className="job-context-row">
                <span className="job-context-key">{k}:</span>
                <span className="job-context-value">{v}</span>
              </div>
            ))}
          </div>
        )}
        {childAgents.length > 0 && (
          <div className="job-followups">
            <div className="job-followups-label">Follow-ups</div>
            {childAgents.map(child => (
              <button
                key={child.id}
                className="followup-link"
                onClick={async () => {
                  const res = await fetch(`/api/agents/${child.id}`);
                  if (res.ok && onContinued) onContinued(await res.json());
                }}
              >
                <span className={`followup-status-dot followup-status-${child.status}`} />
                <span className="followup-description">{child.job_description}</span>
                <span className="followup-id">{child.id.slice(0, 6)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {agent.pending_question && agent.status === 'waiting_user' && (
        <QuestionBubble question={agent.pending_question} />
      )}

      <div className="terminal-tabs">
        <button
          className={`terminal-tab${activeTab === 'output' ? ' terminal-tab-active' : ''}`}
          onClick={() => setActiveTab('output')}
        >
          Output
        </button>
        {(['done', 'failed', 'cancelled'].includes(agent.status)) && (
          <button
            className={`terminal-tab${activeTab === 'changes' ? ' terminal-tab-active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            Changes{diff ? ` (${diff.split('\n').filter(l => l.startsWith('+')).length - diff.split('\n').filter(l => l.startsWith('--- ')).length}+)` : ''}
          </button>
        )}
      </div>

      <div ref={containerRef} className={`xterm-container${activeTab !== 'output' ? ' xterm-hidden' : ''}`} />

      {activeTab === 'changes' && (
        <div className="diff-panel">
          {diff
            ? <DiffViewer diff={diff} />
            : baseSha
              ? <div className="diff-empty">No file changes detected.</div>
              : <div className="diff-empty">No changes captured — the working directory is not a git repository.<br />Initialize git in the work directory to enable diff tracking.</div>
          }
        </div>
      )}

      {agent.status === 'failed' && agent.error_message && (
        <div className="agent-error-banner">
          <div className="agent-error-label">Error output</div>
          <pre className="agent-error-text">{agent.error_message}</pre>
        </div>
      )}

      {agent.status === 'failed' && !agent.session_id && onContinued && (
        <RetryButton agentId={agent.id} onRetried={onContinued} />
      )}

      {(agent.status === 'done' || agent.status === 'failed') && agent.session_id && onContinued && (
        <ContinueInput agentId={agent.id} onContinued={onContinued} />
      )}
    </div>
  );
}
