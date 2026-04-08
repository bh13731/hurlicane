import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  cleanupTestDb,
  createSocketMock,
  insertTestJob,
} from './helpers.js';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'tmux' && args[0] === 'list-sessions') return '';
    return '';
  }),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

vi.mock('../server/orchestrator/PtyManager.js', () => ({
  isTmuxSessionAlive: vi.fn(() => false),
  startInteractiveAgent: vi.fn(),
  saveSnapshot: vi.fn(),
  resolveStandalonePrintJobOutcome: vi.fn(() => null),
}));

vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  runAgent: vi.fn(),
  getLogPath: vi.fn(() => '/dev/null'),
  _resetCompletedJobsForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FileLockRegistry.js', () => ({
  getFileLockRegistry: vi.fn(() => ({
    releaseAll: vi.fn(),
  })),
}));

vi.mock('../server/mcp/McpServer.js', () => ({
  orphanedWaits: new Map(),
  disconnectedAgents: new Map(),
  hasActiveTransport: vi.fn(() => false),
}));

vi.mock('../server/orchestrator/DebateManager.js', () => ({
  onJobCompleted: vi.fn(),
}));

vi.mock('../server/orchestrator/WorkflowManager.js', () => ({
  onJobCompleted: vi.fn(),
  parseMilestones: vi.fn(() => ({ total: 0, done: 0 })),
  writeBlockedDiagnostic: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/RetryManager.js', () => ({
  handleRetry: vi.fn(),
}));

vi.mock('../server/orchestrator/ModelClassifier.js', () => ({
  markModelRateLimited: vi.fn(),
  getFallbackModel: vi.fn((model: string) => model),
  getModelProvider: vi.fn(() => 'anthropic'),
  markProviderRateLimited: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/FailureClassifier.js', () => ({
  classifyFailureText: vi.fn(() => 'unknown'),
  isFallbackEligibleFailure: vi.fn(() => false),
  shouldMarkProviderUnavailable: vi.fn(() => false),
  _resetWarnedUnclassifiedForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/RecoveryLedger.js', () => ({
  claimRecovery: vi.fn(() => true),
}));

vi.mock('../server/orchestrator/WorkQueueManager.js', () => ({
  nudgeQueue: vi.fn(),
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/ProcessPriority.js', () => ({
  _resetForTest: vi.fn(),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('StuckJobWatchdog terminal guards', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
    const { _resetWatchdogStateForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    _resetWatchdogStateForTest();
  });

  afterEach(async () => {
    const { stopWatchdog } = await import('../server/orchestrator/StuckJobWatchdog.js');
    stopWatchdog();
    await cleanupTestDb();
  });

  it('cleans up a stale running agent without rewriting a job that is already done', async () => {
    const queries = await import('../server/db/queries.js');
    const { _invokeWatchdogCheckForTest } = await import('../server/orchestrator/StuckJobWatchdog.js');
    const { onJobCompleted: workflowOnJobCompleted } = await import('../server/orchestrator/WorkflowManager.js');
    const { onJobCompleted: debateOnJobCompleted } = await import('../server/orchestrator/DebateManager.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const job = await insertTestJob({
        id: 'watchdog-terminal-job',
        status: 'done',
        model: 'claude-sonnet-4-6',
      });
      const agent = queries.insertAgent({
        id: 'watchdog-terminal-agent',
        job_id: job.id,
        status: 'running',
      });

      _invokeWatchdogCheckForTest();

      expect(queries.getJobById(job.id)?.status).toBe('done');
      expect(queries.getAgentById(agent.id)?.status).toBe('done');
      expect(workflowOnJobCompleted).not.toHaveBeenCalled();
      expect(debateOnJobCompleted).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("illegal job transition 'done' → 'failed'"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
