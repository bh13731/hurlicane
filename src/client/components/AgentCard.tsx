import React from 'react';
import type { AgentWithJob } from '@shared/types';

interface AgentCardProps {
  agent: AgentWithJob;
  onClick: (agent: AgentWithJob) => void;
  onSelectParent?: (parentId: string) => void;
  templateName?: string;
  isSelected?: boolean;
}

function getBorderColor(agent: AgentWithJob): string {
  switch (agent.status) {
    case 'starting':
    case 'running':
      return '#f59e0b';
    case 'waiting_user':
      return '#ef4444';
    case 'done':
      return agent.output_read ? 'transparent' : '#22c55e';
    case 'failed':
      return 'transparent';
    case 'cancelled':
      return 'transparent';
    default:
      return 'transparent';
  }
}

function getStatusLabel(agent: AgentWithJob): React.ReactNode {
  switch (agent.status) {
    case 'starting': return 'Starting...';
    case 'running': return agent.status_message ?? (agent.job.is_interactive
      ? <>'Running' <span style={{ color: '#ef4444' }}>(interactive)</span></>
      : 'Running');
    case 'waiting_user': return 'Waiting for answer';
    case 'done': return agent.output_read ? 'Done (read)' : 'Done';
    case 'failed': {
      if (agent.output_read) return 'Failed (acknowledged)';
      if (agent.error_message) {
        const lastLine = agent.error_message.trim().split('\n').pop() ?? '';
        return lastLine.slice(0, 60) || 'Failed';
      }
      return 'Failed';
    }
    case 'cancelled': return 'Cancelled';
    default: return agent.status;
  }
}

export function AgentCard({ agent, onClick, onSelectParent, templateName, isSelected }: AgentCardProps) {
  const borderColor = getBorderColor(agent);
  const isWaiting = agent.status === 'waiting_user';

  function handleFlag(e: React.MouseEvent) {
    e.stopPropagation();
    fetch(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' });
  }

  function handleGoToParent(e: React.MouseEvent) {
    e.stopPropagation();
    if (agent.parent_agent_id && onSelectParent) {
      onSelectParent(agent.parent_agent_id);
    }
  }

  return (
    <div
      className={`agent-card${isSelected ? ' agent-card-selected' : ''}`}
      style={borderColor !== 'transparent' ? { borderLeftColor: borderColor, borderLeftWidth: 3 } : undefined}
      onClick={() => onClick(agent)}
    >
      <div className="agent-card-header">
        <span className="agent-id">Agent {agent.id.slice(0, 6)}</span>
        {agent.parent_agent_id && onSelectParent && (
          <button
            className="parent-link-btn"
            onClick={handleGoToParent}
            title={`Go to parent agent ${agent.parent_agent_id.slice(0, 6)}`}
          >
            ↑ parent
          </button>
        )}
        <button
          className={`flag-btn${agent.job.flagged ? ' flag-btn-active' : ''}`}
          onClick={handleFlag}
          title={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
          aria-label={agent.job.flagged ? 'Remove flag' : 'Flag for review'}
          aria-pressed={!!agent.job.flagged}
        >
          ⚑
        </button>
        <span className={`agent-status-badge status-${agent.status}`}>
          {agent.status}
        </span>
      </div>
      <div className="agent-job-title">{agent.job.title}</div>
      <div className="agent-status-msg">{getStatusLabel(agent)}</div>
      {templateName && (
        <div className="agent-template" title={templateName}>
          {templateName}
        </div>
      )}
      {agent.job.model && (
        <div className="agent-model" title={agent.job.model}>
          {agent.job.model.replace('claude-', '')}
        </div>
      )}

      {agent.job.debate_id && (
        <div className="agent-debate-badge" title={`Debate round ${agent.job.debate_round}, ${agent.job.debate_role} side`}>
          R{agent.job.debate_round} {agent.job.debate_role === 'claude' ? 'Claude' : 'Codex'}
        </div>
      )}

      {agent.active_locks.length > 0 && (
        <div className="agent-locks">
          {agent.active_locks.slice(0, 3).map(lock => (
            <span key={lock.id} className="lock-badge" title={lock.reason ?? ''}>
              {lock.file_path.split('/').pop()}
            </span>
          ))}
          {agent.active_locks.length > 3 && (
            <span className="lock-badge">+{agent.active_locks.length - 3}</span>
          )}
        </div>
      )}

      {isWaiting && agent.pending_question && (
        <div className="agent-question-preview">
          <span className="question-icon">?</span>
          {agent.pending_question.question.slice(0, 80)}
          {agent.pending_question.question.length > 80 ? '...' : ''}
        </div>
      )}
    </div>
  );
}
