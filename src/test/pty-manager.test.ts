import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, createSocketMock, setupTestDb } from './helpers.js';

const execFileSyncMock = vi.fn((cmd: string, args: string[]) => {
  if (cmd !== 'tmux') return Buffer.from('');

  if (args[0] === 'list-sessions') {
    return Buffer.from('');
  }

  if (args[0] === 'has-session') {
    return Buffer.from('');
  }

  return Buffer.from('');
});

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../server/socket/SocketManager.js', () => createSocketMock());

const startTailingMock = vi.fn();
const stopTailingMock = vi.fn();
const handleJobCompletionMock = vi.fn(async () => {});

vi.mock('../server/orchestrator/AgentRunner.js', () => ({
  SYSTEM_PROMPT: 'test system prompt',
  HOOK_SETTINGS: {},
  handleJobCompletion: handleJobCompletionMock,
  cancelledAgents: new Set<string>(),
  startTailing: startTailingMock,
  stopTailing: stopTailingMock,
  readClaudeMd: vi.fn(() => ''),
  buildMemorySection: vi.fn(() => ''),
}));

vi.mock('../server/orchestrator/ProcessPriority.js', () => ({
  wrapExecLineWithNice: vi.fn((line: string) => line),
}));

vi.mock('../server/orchestrator/ResilienceLogger.js', () => ({
  logResilienceEvent: vi.fn(),
}));

vi.mock('../server/instrument.js', () => ({
  captureWithContext: vi.fn(),
}));

describe('PtyManager spawning state', () => {
  beforeEach(async () => {
    await setupTestDb();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { _resetPtyManagerStateForTest } = await import('../server/orchestrator/PtyManager.js');
    _resetPtyManagerStateForTest();
    await cleanupTestDb();
  });

  it('does not kill tmux sessions for agents that are still spawning', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'list-sessions') {
        return Buffer.from('orchestrator-spawning-agent\norchestrator-stale-agent\n');
      }
      return Buffer.from('');
    });

    const {
      _cleanupStaleTmuxSessionsForTest,
      _seedSpawningAgentForTest,
    } = await import('../server/orchestrator/PtyManager.js');

    _seedSpawningAgentForTest('spawning-agent');
    _cleanupStaleTmuxSessionsForTest();

    const killCalls = execFileSyncMock.mock.calls.filter(([cmd, args]) =>
      cmd === 'tmux' && Array.isArray(args) && args[0] === 'kill-session'
    );

    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]?.[1]).toEqual(['kill-session', '-t', 'orchestrator-stale-agent']);
  });

  it('clears spawning state when a standalone print job switches to monitor mode', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'tmux' && args[0] === 'has-session') {
        return Buffer.from('');
      }
      return Buffer.from('');
    });

    const {
      _isAgentSpawningForTest,
      _seedSpawningAgentForTest,
      attachPty,
    } = await import('../server/orchestrator/PtyManager.js');

    const agentId = 'standalone-agent';
    _seedSpawningAgentForTest(agentId);

    await attachPty(agentId, {
      id: 'job-1',
      title: 'Standalone print job',
      work_dir: process.cwd(),
      is_interactive: false,
      debate_role: null,
      workflow_phase: null,
    } as any);

    expect(_isAgentSpawningForTest(agentId)).toBe(false);
    expect(startTailingMock).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ id: 'job-1' }),
      expect.stringContaining(`${agentId}.ndjson`),
      0,
      null,
    );
    expect(handleJobCompletionMock).not.toHaveBeenCalled();
  });
});
