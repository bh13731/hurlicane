// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { AgentCard } from '../../client/components/AgentCard';
import { makeAgent, makeJob, makeWarning, makeLock, makeQuestion } from './factories';
import './setup';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('ok'))));
});

describe('AgentCard', () => {
  it('renders agent id and job title', () => {
    const agent = makeAgent({ id: 'abc123def456', job: makeJob({ title: 'Fix bug in parser' }) });
    render(<AgentCard agent={agent} onClick={vi.fn()} />);
    expect(screen.getByText('Agent abc123')).toBeInTheDocument();
    expect(screen.getByText('Fix bug in parser')).toBeInTheDocument();
  });

  it('shows running status badge with correct class', () => {
    const agent = makeAgent({ status: 'running' });
    const { container } = render(<AgentCard agent={agent} onClick={vi.fn()} />);
    const badge = container.querySelector('.agent-status-badge.status-running');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('running');
  });

  it('shows done status when agent is finished and unread', () => {
    const agent = makeAgent({
      status: 'done', output_read: 0, finished_at: Date.now(), duration_ms: 5000,
      cost_usd: 0.25, job: makeJob({ status: 'done' }),
    });
    const { container } = render(<AgentCard agent={agent} onClick={vi.fn()} />);
    expect(container.querySelector('.agent-status-badge.status-done')).toBeTruthy();
    expect(container.querySelector('.agent-status-msg')?.textContent).toBe('Done');
  });

  it('shows failed status with error message excerpt', () => {
    const agent = makeAgent({
      status: 'failed', output_read: 0,
      error_message: 'Something went terribly wrong\nThe process crashed',
      finished_at: Date.now(), duration_ms: 3000, job: makeJob({ status: 'failed' }),
    });
    const { container } = render(<AgentCard agent={agent} onClick={vi.fn()} />);
    expect(container.querySelector('.agent-status-badge.status-failed')).toBeTruthy();
    expect(screen.getByText('The process crashed')).toBeInTheDocument();
  });

  it('shows waiting_user status with question preview', () => {
    const q = makeQuestion({ question: 'Should I proceed with the deletion of the database records?' });
    const agent = makeAgent({ status: 'waiting_user', pending_question: q });
    render(<AgentCard agent={agent} onClick={vi.fn()} />);
    expect(screen.getByText('Waiting for answer')).toBeInTheDocument();
    expect(screen.getByText(/Should I proceed with the deletion/)).toBeInTheDocument();
  });

  it('calls onClick when card is clicked', () => {
    const agent = makeAgent();
    const onClick = vi.fn();
    const { container } = render(<AgentCard agent={agent} onClick={onClick} />);
    fireEvent.click(container.querySelector('.agent-card')!);
    expect(onClick).toHaveBeenCalledWith(agent);
  });

  it('shows flag button and calls API on click', () => {
    const agent = makeAgent();
    render(<AgentCard agent={agent} onClick={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Flag for review'));
    expect(fetch).toHaveBeenCalledWith(`/api/jobs/${agent.job.id}/flag`, { method: 'POST' });
  });

  it('shows archive button only for terminal job statuses', () => {
    const agent = makeAgent({
      status: 'done', output_read: 0, finished_at: Date.now(),
      duration_ms: 1000, cost_usd: 0.1, job: makeJob({ status: 'done' }),
    });
    const onArchive = vi.fn();
    render(<AgentCard agent={agent} onClick={vi.fn()} onArchiveJob={onArchive} />);
    fireEvent.click(screen.getByLabelText('Archive job'));
    expect(onArchive).toHaveBeenCalled();
  });

  it('does not show archive button for running agents', () => {
    const agent = makeAgent({ status: 'running', job: makeJob({ status: 'running' }) });
    render(<AgentCard agent={agent} onClick={vi.fn()} onArchiveJob={vi.fn()} />);
    expect(screen.queryByLabelText('Archive job')).not.toBeInTheDocument();
  });

  it('shows requeue button for active agents', () => {
    const { container } = render(<AgentCard agent={makeAgent({ status: 'running' })} onClick={vi.fn()} />);
    expect(container.querySelector('.requeue-btn')).toBeTruthy();
  });

  it('shows model name with claude- prefix stripped', () => {
    const agent = makeAgent({ job: makeJob({ model: 'claude-sonnet-4-6' }) });
    const { container } = render(<AgentCard agent={agent} onClick={vi.fn()} />);
    expect(container.querySelector('.agent-model')?.textContent).toBe('sonnet-4-6');
  });

  it('shows template name when provided', () => {
    render(<AgentCard agent={makeAgent()} onClick={vi.fn()} templateName="Bug Fix Template" />);
    expect(screen.getByText('Bug Fix Template')).toBeInTheDocument();
  });

  it('shows active locks', () => {
    const locks = [makeLock({ file_path: '/src/utils/helper.ts' }), makeLock({ file_path: '/src/config.ts' })];
    render(<AgentCard agent={makeAgent({ active_locks: locks })} onClick={vi.fn()} />);
    expect(screen.getByText('helper.ts')).toBeInTheDocument();
    expect(screen.getByText('config.ts')).toBeInTheDocument();
  });

  it('shows warnings when present', () => {
    render(<AgentCard agent={makeAgent({ warnings: [makeWarning({ message: 'Agent appears stalled' })] })} onClick={vi.fn()} />);
    expect(screen.getByText(/Agent appears stalled/)).toBeInTheDocument();
  });

  it('shows retry badge for retry jobs', () => {
    render(<AgentCard agent={makeAgent({ job: makeJob({ original_job_id: 'orig-123', retry_count: 2, max_retries: 3 }) })} onClick={vi.fn()} />);
    expect(screen.getByText('Retry 2/3')).toBeInTheDocument();
  });

  it('shows debate badge for debate jobs', () => {
    render(<AgentCard agent={makeAgent({ job: makeJob({ debate_id: 'd1', debate_round: 2, debate_role: 'claude' }) })} onClick={vi.fn()} />);
    expect(screen.getByText('R2 Claude')).toBeInTheDocument();
  });

  it('shows elapsed time for running agents', () => {
    const now = Date.now();
    render(<AgentCard agent={makeAgent({ status: 'running', started_at: now - 125_000 })} onClick={vi.fn()} now={now} />);
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
  });

  it('shows cost estimate for running agents with token data', () => {
    const now = Date.now();
    const agent = makeAgent({
      status: 'running', started_at: now - 30_000,
      estimated_input_tokens: 10_000, estimated_output_tokens: 1_000,
      job: makeJob({ model: 'claude-sonnet-4-6' }),
    });
    const { container } = render(<AgentCard agent={agent} onClick={vi.fn()} now={now} />);
    // sonnet pricing: (10000/1M)*3 + (1000/1M)*15 = 0.03 + 0.015 = 0.045
    // formatCost: < 0.01 threshold not met, so approximate ~$0.05 with toFixed(2)
    const costText = container.querySelector('.agent-card-cost')?.textContent ?? '';
    expect(costText).toMatch(/~\$0\.0[45]/);
  });

  it('shows parent link button when parent exists', () => {
    const onSelectParent = vi.fn();
    render(<AgentCard agent={makeAgent({ parent_agent_id: 'parent-abc' })} onClick={vi.fn()} onSelectParent={onSelectParent} />);
    fireEvent.click(screen.getByTitle(/Go to parent agent/));
    expect(onSelectParent).toHaveBeenCalledWith('parent-abc');
  });

  it('applies selected style when isSelected is true', () => {
    const { container } = render(<AgentCard agent={makeAgent()} onClick={vi.fn()} isSelected={true} />);
    expect(container.querySelector('.agent-card-selected')).toBeTruthy();
  });
});
