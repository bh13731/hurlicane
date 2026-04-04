import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb, createSocketMock } from './helpers.js';

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());
vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

// Mock createAutonomousAgentRun so we can capture the CreateWorkflowRequest it receives
const mockCreateAutonomousAgentRun = vi.fn((req: any) => ({
  workflow: {
    id: 'wf-1',
    title: req.title ?? 'Test Workflow',
    task: req.task,
    status: 'running',
    implementer_model: req.implementerModel ?? 'claude-sonnet-4-6',
    reviewer_model: req.reviewerModel ?? 'codex',
    work_dir: req.workDir ?? null,
    max_cycles: req.maxCycles ?? 10,
    current_cycle: 0,
    current_phase: 'assess',
    milestones_total: 0,
    milestones_done: 0,
    project_id: 'proj-1',
    use_worktree: req.useWorktree ? 1 : 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  },
  project: { id: 'proj-1', name: 'Test', description: '', created_at: Date.now(), updated_at: Date.now() },
  jobs: [{ id: 'assess-job-1', title: 'Assess', status: 'queued' }],
}));

vi.mock('../server/orchestrator/AutonomousAgentRunManager.js', () => ({
  createAutonomousAgentRun: mockCreateAutonomousAgentRun,
}));

describe('createTaskCore — MCP workflow-route model inheritance', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await cleanupTestDb();
  });

  it('inherits model from parent job when request omits model on workflow route', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    const result = createTaskCore(
      { description: 'Build a feature', iterations: 5 },
      { inheritedModel: 'claude-opus-4-6' },
    );

    expect(result.response.task_type).toBe('workflow');
    // The mock was called with a CreateWorkflowRequest — verify inheritedModel was applied
    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
    const workflowReq = mockCreateAutonomousAgentRun.mock.calls[0][0];
    expect(workflowReq.implementerModel).toBe('claude-opus-4-6');
  });

  it('explicit model in request wins over inherited model on workflow route', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    const result = createTaskCore(
      { description: 'Build a feature', iterations: 5, model: 'claude-sonnet-4-6' },
      { inheritedModel: 'claude-opus-4-6' },
    );

    expect(result.response.task_type).toBe('workflow');
    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
    const workflowReq = mockCreateAutonomousAgentRun.mock.calls[0][0];
    // Explicit model should win — taskToWorkflowRequest sets implementerModel from req.model
    expect(workflowReq.implementerModel).toBe('claude-sonnet-4-6');
  });

  it('inherited workDir flows through on workflow route when model is also inherited', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    // workDir is set on the request (as the MCP handler would after inheriting from parent job)
    const result = createTaskCore(
      { description: 'Build a feature', iterations: 5, workDir: '/repo/project' },
      { inheritedModel: 'claude-opus-4-6' },
    );

    expect(result.response.task_type).toBe('workflow');
    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
    const workflowReq = mockCreateAutonomousAgentRun.mock.calls[0][0];
    expect(workflowReq.workDir).toBe('/repo/project');
    expect(workflowReq.implementerModel).toBe('claude-opus-4-6');
  });

  it('inherited model applies on job route too', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    const result = createTaskCore(
      { description: 'Quick fix' },
      { inheritedModel: 'claude-opus-4-6' },
    );

    expect(result.response.task_type).toBe('job');
    // Job should have the inherited model
    expect(result.response.job!.model).toBe('claude-opus-4-6');
  });

  it('explicit model wins over inherited model on job route', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    const result = createTaskCore(
      { description: 'Quick fix', model: 'claude-haiku-4-5-20251001' },
      { inheritedModel: 'claude-opus-4-6' },
    );

    expect(result.response.task_type).toBe('job');
    expect(result.response.job!.model).toBe('claude-haiku-4-5-20251001');
  });

  it('no inheritedModel leaves implementerModel as undefined on workflow route', async () => {
    const { createTaskCore } = await import('../server/api/tasks.js');

    createTaskCore(
      { description: 'Build a feature', iterations: 5 },
      {},
    );

    expect(mockCreateAutonomousAgentRun).toHaveBeenCalledTimes(1);
    const workflowReq = mockCreateAutonomousAgentRun.mock.calls[0][0];
    // taskToWorkflowRequest maps req.model (undefined) → implementerModel (undefined)
    expect(workflowReq.implementerModel).toBeUndefined();
  });
});
