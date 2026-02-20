import React, { useState, useRef, useEffect } from 'react';
import { AgentCard } from './AgentCard';
import type { AgentWithJob, AgentStatus, Job } from '@shared/types';

interface AgentGridProps {
  agents: AgentWithJob[];
  queuedJobs?: Job[];
  onSelectAgent: (agent: AgentWithJob) => void;
  templates?: unknown;
  selectedAgentId?: string | null;
}

const ALL_STATUSES: AgentStatus[] = ['starting', 'running', 'waiting_user', 'done', 'failed'];

const STATUS_LABELS: Record<AgentStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  waiting_user: 'Waiting',
  done: 'Done',
  failed: 'Failed',
};

function tilePriority(agent: AgentWithJob): number {
  if (agent.status === 'running' || agent.status === 'starting') return 0;
  if (agent.status === 'waiting_user') return 1;
  if ((agent.status === 'done' || agent.status === 'failed') && agent.output_read === 0) return 2;
  if (agent.job.flagged) return 3;
  return 4;
}

export function AgentGrid({ agents, queuedJobs = [], onSelectAgent, selectedAgentId }: AgentGridProps) {
  const [activeFilters, setActiveFilters] = useState<Set<AgentStatus>>(new Set());
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  const [customOrder, setCustomOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceId = useRef<string | null>(null);

  // Sync customOrder when agents are added or removed
  useEffect(() => {
    setCustomOrder(prev => {
      const agentIds = new Set(agents.map(a => a.id));
      const kept = prev.filter(id => agentIds.has(id));
      const existingSet = new Set(kept);
      const newIds = agents.filter(a => !existingSet.has(a.id)).map(a => a.id);
      if (newIds.length === 0 && kept.length === prev.length) return prev;
      return [...newIds, ...kept];
    });
  }, [agents]);

  function toggleFilter(status: AgentStatus) {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }

  // Priority groups are enforced; within each group, drag order applies, then time
  const orderedAgents = [...agents].sort((a, b) => {
    const pa = tilePriority(a);
    const pb = tilePriority(b);
    if (pa !== pb) return pa - pb;
    const ai = customOrder.indexOf(a.id);
    const bi = customOrder.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return b.updated_at - a.updated_at;
  });

  const counts = Object.fromEntries(
    ALL_STATUSES.map(s => [s, agents.filter(a => a.status === s).length])
  ) as Record<AgentStatus, number>;

  const flaggedCount = agents.filter(a => a.job.flagged).length;

  const visibleAgents = (() => {
    let result = activeFilters.size === 0
      ? orderedAgents
      : orderedAgents.filter(a => activeFilters.has(a.status));
    if (showFlaggedOnly) result = result.filter(a => a.job.flagged);
    return result;
  })();

  const presentStatuses = ALL_STATUSES.filter(s => counts[s] > 0);

  function handleDragStart(id: string) {
    dragSourceId.current = id;
    setDraggingId(id);
  }

  function handleDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    if (dragSourceId.current !== id) {
      setDragOverId(id);
    }
  }

  function handleDragLeave(e: React.DragEvent, id: string) {
    if (dragOverId === id && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverId(null);
    }
  }

  function handleDrop(targetId: string) {
    const sourceId = dragSourceId.current;
    if (sourceId && sourceId !== targetId) {
      setCustomOrder(prev => {
        const next = [...prev];
        const si = next.indexOf(sourceId);
        const ti = next.indexOf(targetId);
        if (si === -1 || ti === -1) return prev;
        next.splice(si, 1);
        next.splice(ti, 0, sourceId);
        return next;
      });
    }
    setDragOverId(null);
    setDraggingId(null);
    dragSourceId.current = null;
  }

  function handleDragEnd() {
    setDragOverId(null);
    setDraggingId(null);
    dragSourceId.current = null;
  }

  return (
    <div className="agent-grid-container">
      {agents.length > 0 && (presentStatuses.length > 1 || flaggedCount > 0) && (
        <div className="agent-filter-bar">
          {presentStatuses.map(status => (
            <button
              key={status}
              className={`agent-filter-btn status-filter-${status} ${activeFilters.has(status) ? 'agent-filter-btn-active' : ''}`}
              onClick={() => toggleFilter(status)}
            >
              {STATUS_LABELS[status]}
              <span className="agent-filter-count">{counts[status]}</span>
            </button>
          ))}
          {flaggedCount > 0 && (
            <button
              className={`agent-filter-btn agent-filter-flagged${showFlaggedOnly ? ' agent-filter-btn-active agent-filter-flagged-active' : ''}`}
              onClick={() => setShowFlaggedOnly(v => !v)}
            >
              ⚑ Flagged
              <span className="agent-filter-count">{flaggedCount}</span>
            </button>
          )}
          {(activeFilters.size > 0 || showFlaggedOnly) && (
            <button
              className="agent-filter-btn agent-filter-clear"
              onClick={() => { setActiveFilters(new Set()); setShowFlaggedOnly(false); }}
            >
              Clear
            </button>
          )}
          {agents.some(a => (a.job as any).is_interactive && (a.status === 'running' || a.status === 'starting')) && (
            <button
              className="btn btn-danger btn-sm"
              onClick={() => fetch('/api/agents/disconnect-all', { method: 'DELETE' })}
            >
              Disconnect All
            </button>
          )}
        </div>
      )}

      {visibleAgents.length === 0 && queuedJobs.length === 0 ? (
        <div className="agent-grid-empty">
          <p>{agents.length === 0 ? 'No agents running. Submit a job to get started.' : 'No agents match the selected filters.'}</p>
        </div>
      ) : (
        <div className="agent-grid">
          {visibleAgents.map(agent => (
            <div
              key={agent.id}
              draggable
              onDragStart={() => handleDragStart(agent.id)}
              onDragOver={e => handleDragOver(e, agent.id)}
              onDragLeave={e => handleDragLeave(e, agent.id)}
              onDrop={() => handleDrop(agent.id)}
              onDragEnd={handleDragEnd}
              className={[
                'agent-drag-wrapper',
                draggingId === agent.id ? 'agent-drag-source' : '',
                dragOverId === agent.id ? 'agent-drag-over' : '',
              ].join(' ')}
            >
              <AgentCard
                agent={agent}
                onClick={onSelectAgent}
                onSelectParent={(parentId) => {
                  const parent = agents.find(a => a.id === parentId);
                  if (parent) onSelectAgent(parent);
                }}
                templateName={agent.template_name ?? undefined}
                isSelected={selectedAgentId === agent.id}
              />
            </div>
          ))}
          {queuedJobs.map(job => (
            <div key={job.id} className="agent-drag-wrapper">
              <div className="agent-card agent-card-queued">
                <div className="agent-card-header">
                  <span className="agent-status-badge agent-status-queued">Queued</span>
                </div>
                <div className="agent-card-title">{job.title}</div>
                <div className="agent-card-queued-hint">Waiting for an available agent slot</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
