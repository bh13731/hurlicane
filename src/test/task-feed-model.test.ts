import { describe, it, expect } from 'vitest';
import { buildGroupedTaskItems, type TaskItem } from '../client/taskFeedModel';
import type { Workflow, AgentWithJob, Job } from '@shared/types';

// ─── Test data factories ────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    title: 'Test Workflow',
    task: 'do stuff',
    work_dir: null,
    implementer_model: 'claude-sonnet-4-6',
    reviewer_model: 'claude-sonnet-4-6',
    max_cycles: 3,
    current_cycle: 1,
    current_phase: 'implement',
    status: 'running',
    milestones_total: 3,
    milestones_done: 0,
    project_id: null,
    max_turns_assess: 50,
    max_turns_review: 50,
    max_turns_implement: 200,
    stop_mode_assess: 'turns',
    stop_value_assess: null,
    stop_mode_review: 'turns',
    stop_value_review: null,
    stop_mode_implement: 'turns',
    stop_value_implement: null,
    template_id: null,
    use_worktree: 1,
    worktree_path: null,
    worktree_branch: null,
    blocked_reason: null,
    pr_url: null,
    completion_threshold: 100,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    title: 'Test Job',
    description: 'desc',
    context: null,
    status: 'queued',
    priority: 0,
    work_dir: null,
    max_turns: 50,
    stop_mode: 'turns',
    stop_value: null,
    model: null,
    template_id: null,
    depends_on: null,
    flagged: 0,
    is_interactive: 0,
    use_worktree: 0,
    project_id: null,
    debate_id: null,
    debate_loop: null,
    debate_round: null,
    debate_role: null,
    scheduled_at: null,
    repeat_interval_ms: null,
    retry_policy: 'none',
    max_retries: 0,
    retry_count: 0,
    original_job_id: null,
    completion_checks: null,
    review_config: null,
    review_status: null,
    review_parent_job_id: null,
    created_by_agent_id: null,
    pre_debate_id: null,
    pre_debate_summary: null,
    workflow_id: null,
    workflow_cycle: null,
    workflow_phase: null,
    pr_url: null,
    archived_at: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentWithJob> = {}, jobOverrides: Partial<Job> = {}): AgentWithJob {
  const job = makeJob({ id: 'job-a1', status: 'running', ...jobOverrides });
  return {
    id: 'agent-1',
    job_id: job.id,
    status: 'running',
    pid: 123,
    session_id: null,
    parent_agent_id: null,
    exit_code: null,
    error_message: null,
    status_message: null,
    output_read: 0,
    base_sha: null,
    diff: null,
    cost_usd: null,
    duration_ms: null,
    num_turns: null,
    estimated_input_tokens: null,
    estimated_output_tokens: null,
    pending_wait_ids: null,
    started_at: 1500,
    updated_at: 2000,
    finished_at: null,
    job,
    template_name: null,
    pending_question: null,
    active_locks: [],
    child_agents: [],
    warnings: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const NOW = 10000;

describe('buildGroupedTaskItems', () => {
  it('classifies running workflow as active', () => {
    const wf = makeWorkflow({ status: 'running' });
    const result = buildGroupedTaskItems([wf], [], [], NOW);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].kind).toBe('workflow');
    expect(result.attention).toHaveLength(0);
    expect(result.recent).toHaveLength(0);
  });

  it('classifies blocked and failed workflows as attention', () => {
    const blocked = makeWorkflow({ id: 'wf-blocked', status: 'blocked', blocked_reason: 'stuck' });
    const failed = makeWorkflow({ id: 'wf-failed', status: 'failed' });
    const result = buildGroupedTaskItems([blocked, failed], [], [], NOW);
    expect(result.attention).toHaveLength(2);
    // Failed should come before blocked (lower severity number)
    expect((result.attention[0] as any).workflow.status).toBe('failed');
    expect((result.attention[1] as any).workflow.status).toBe('blocked');
  });

  it('classifies complete workflow as recent when within window', () => {
    const wf = makeWorkflow({ status: 'complete', updated_at: NOW - 1000 });
    const result = buildGroupedTaskItems([wf], [], [], NOW, 60_000);
    expect(result.recent).toHaveLength(1);
  });

  it('excludes complete workflow outside recent window', () => {
    const wf = makeWorkflow({ status: 'complete', updated_at: NOW - 120_000 });
    const result = buildGroupedTaskItems([wf], [], [], NOW, 60_000);
    expect(result.recent).toHaveLength(0);
  });

  it('classifies running agents as active', () => {
    const agent = makeAgent({ status: 'running' });
    const result = buildGroupedTaskItems([], [agent], [], NOW);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].kind).toBe('agent');
  });

  it('classifies waiting_user agents as attention', () => {
    const agent = makeAgent({ status: 'waiting_user' });
    const result = buildGroupedTaskItems([], [agent], [], NOW);
    expect(result.attention).toHaveLength(1);
  });

  it('classifies failed agents as attention', () => {
    const agent = makeAgent({ status: 'failed' });
    const result = buildGroupedTaskItems([], [agent], [], NOW);
    expect(result.attention).toHaveLength(1);
  });

  it('classifies queued standalone jobs as active', () => {
    const job = makeJob({ id: 'q1', status: 'queued' });
    const result = buildGroupedTaskItems([], [], [job], NOW);
    expect(result.active).toHaveLength(1);
    expect(result.active[0].kind).toBe('queued_job');
  });

  it('produces no duplicates when given distinct items', () => {
    const wf = makeWorkflow({ id: 'wf-1', status: 'running' });
    const agent = makeAgent({ id: 'ag-1', status: 'running' });
    const job = makeJob({ id: 'q-1', status: 'queued' });
    const result = buildGroupedTaskItems([wf], [agent], [job], NOW);
    const allIds = [...result.attention, ...result.active, ...result.recent].map(i => i.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('mixes workflow and agent items in the same groups', () => {
    const wf = makeWorkflow({ id: 'wf-att', status: 'blocked' });
    const agent = makeAgent({ id: 'ag-att', status: 'failed' });
    const result = buildGroupedTaskItems([wf], [agent], [], NOW);
    expect(result.attention).toHaveLength(2);
    const kinds = result.attention.map(i => i.kind);
    expect(kinds).toContain('workflow');
    expect(kinds).toContain('agent');
  });

  it('sorts active items by start/creation time ascending', () => {
    const wf = makeWorkflow({ id: 'wf-late', status: 'running', created_at: 5000 });
    const agent = makeAgent({ id: 'ag-early', status: 'running', started_at: 1000 });
    const job = makeJob({ id: 'q-mid', status: 'queued', created_at: 3000 });
    const result = buildGroupedTaskItems([wf], [agent], [job], NOW);
    expect(result.active.map(i => i.id)).toEqual(['agent-ag-early', 'job-q-mid', 'wf-wf-late']);
  });

  it('sorts recent items by completion time descending (most recent first)', () => {
    const wf = makeWorkflow({ id: 'wf-old', status: 'complete', updated_at: NOW - 5000 });
    const agent = makeAgent({ id: 'ag-new', status: 'done', finished_at: NOW - 1000, updated_at: NOW - 1000 });
    const result = buildGroupedTaskItems([wf], [agent], [], NOW, 60_000);
    expect(result.recent.map(i => i.id)).toEqual(['agent-ag-new', 'wf-wf-old']);
  });

  it('handles empty inputs', () => {
    const result = buildGroupedTaskItems([], [], [], NOW);
    expect(result.attention).toHaveLength(0);
    expect(result.active).toHaveLength(0);
    expect(result.recent).toHaveLength(0);
  });

  // ── M2: Deduplication and workflow-exclusion regression tests ──────────────

  describe('workflow-owned exclusion', () => {
    it('excludes agents whose jobs belong to a workflow', () => {
      const wf = makeWorkflow({ id: 'wf-1', status: 'running' });
      const ownedAgent = makeAgent(
        { id: 'owned-ag', status: 'running' },
        { id: 'owned-job', workflow_id: 'wf-1' },
      );
      const standaloneAgent = makeAgent(
        { id: 'standalone-ag', status: 'running' },
        { id: 'standalone-job', workflow_id: null },
      );
      const result = buildGroupedTaskItems([wf], [ownedAgent, standaloneAgent], [], NOW);
      const agentIds = [...result.attention, ...result.active, ...result.recent]
        .filter(i => i.kind === 'agent')
        .map(i => i.id);
      // Only standalone agent should appear
      expect(agentIds).toEqual(['agent-standalone-ag']);
    });

    it('excludes queued jobs that belong to a workflow', () => {
      const wf = makeWorkflow({ id: 'wf-1', status: 'running' });
      const ownedJob = makeJob({ id: 'wf-job', workflow_id: 'wf-1' });
      const standaloneJob = makeJob({ id: 'standalone-job', workflow_id: null });
      const result = buildGroupedTaskItems([wf], [], [ownedJob, standaloneJob], NOW);
      const jobIds = [...result.attention, ...result.active, ...result.recent]
        .filter(i => i.kind === 'queued_job')
        .map(i => i.id);
      expect(jobIds).toEqual(['job-standalone-job']);
    });
  });

  describe('agent/queued-job overlap deduplication', () => {
    it('excludes queued job when an agent already exists for the same job', () => {
      const job = makeJob({ id: 'shared-job', status: 'running', workflow_id: null });
      const agent = makeAgent(
        { id: 'ag-for-shared', status: 'running', job_id: 'shared-job' },
        { id: 'shared-job', workflow_id: null },
      );
      // Pass the same job as both an agent entry and a queued job
      const result = buildGroupedTaskItems([], [agent], [job], NOW);
      const allItems = [...result.attention, ...result.active, ...result.recent];
      // Should have exactly 1 item — the agent, not the queued job duplicate
      expect(allItems).toHaveLength(1);
      expect(allItems[0].kind).toBe('agent');
      expect(allItems[0].id).toBe('agent-ag-for-shared');
    });

    it('keeps queued job when no agent exists for it', () => {
      const agent = makeAgent(
        { id: 'ag-other', status: 'running', job_id: 'other-job' },
        { id: 'other-job', workflow_id: null },
      );
      const queuedJob = makeJob({ id: 'new-job', workflow_id: null });
      const result = buildGroupedTaskItems([], [agent], [queuedJob], NOW);
      const allItems = [...result.attention, ...result.active, ...result.recent];
      expect(allItems).toHaveLength(2);
      expect(allItems.map(i => i.kind).sort()).toEqual(['agent', 'queued_job']);
    });
  });

  describe('overlapping inputs do not produce duplicates', () => {
    it('handles overlapping workflow-owned agents + workflows without duplicates', () => {
      const wf = makeWorkflow({ id: 'wf-1', status: 'running' });
      const ownedAgent1 = makeAgent(
        { id: 'impl-ag', status: 'running' },
        { id: 'impl-job', workflow_id: 'wf-1', workflow_phase: 'implement' as any },
      );
      const ownedAgent2 = makeAgent(
        { id: 'review-ag', status: 'done', finished_at: NOW - 500, updated_at: NOW - 500 },
        { id: 'review-job', workflow_id: 'wf-1', workflow_phase: 'review' as any },
      );
      const standaloneAgent = makeAgent(
        { id: 'solo-ag', status: 'running' },
        { id: 'solo-job', workflow_id: null },
      );
      const result = buildGroupedTaskItems([wf], [ownedAgent1, ownedAgent2, standaloneAgent], [], NOW);
      const allItems = [...result.attention, ...result.active, ...result.recent];
      const allIds = allItems.map(i => i.id);
      // Workflow + standalone agent only; owned agents excluded
      expect(allIds.sort()).toEqual(['agent-solo-ag', 'wf-wf-1'].sort());
    });

    it('handles full overlap scenario: workflow + owned agent + owned queued job', () => {
      const wf = makeWorkflow({ id: 'wf-x', status: 'running' });
      const ownedAgent = makeAgent(
        { id: 'wf-ag', status: 'running' },
        { id: 'wf-ag-job', workflow_id: 'wf-x' },
      );
      const ownedQueuedJob = makeJob({ id: 'wf-q-job', workflow_id: 'wf-x' });
      const result = buildGroupedTaskItems([wf], [ownedAgent], [ownedQueuedJob], NOW);
      const allItems = [...result.attention, ...result.active, ...result.recent];
      // Only the workflow itself should appear
      expect(allItems).toHaveLength(1);
      expect(allItems[0].kind).toBe('workflow');
    });
  });
});
