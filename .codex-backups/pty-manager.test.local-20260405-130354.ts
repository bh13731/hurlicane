/**
 * Unit tests for PtyManager resource availability, backoff logic, and onExit
 * completion semantics for standalone --print jobs.
 *
 * Tests the pure decision logic:
 * - Resource availability checking (checkPtyResourceAvailability)
 * - Backoff escalation/reset logic
 * - Session name generation
 * - isAutoExitJob classification and its effect on session cleanup
 * - Stale tmux session identification and cleanup
 * - statusFromNdjson: reads ndjson log to resolve done/failed/null
 * - checkCommitsSince: commits since base_sha as fallback evidence of work done
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { cleanupTestDb, setupTestDb, resetManagerState } from './helpers.js';

describe('PtyManager', () => {
  beforeEach(async () => {
    await setupTestDb();
    await resetManagerState();
  });

  afterEach(async () => {
    const { _resetPtyManagerStateForTest } = await import('../server/orchestrator/PtyManager.js');
    _resetPtyManagerStateForTest();
    await cleanupTestDb();
  });

  describe('resource availability checking', () => {
    it('exposes checkPtyResourceAvailability for testing', async () => {
      const { _checkPtyResourceAvailabilityForTest } = await import('../server/orchestrator/PtyManager.js');
      const result = _checkPtyResourceAvailabilityForTest();
      expect(result).toHaveProperty('ok');
      expect(typeof result.ok).toBe('boolean');
    });

    it('checks backoff cooldown expiry', async () => {
      // Implementation in M5
    });

    it('returns ok:false when system PTY unavailable', async () => {
      // Implementation in M5 (with mocked /dev/ptmx)
    });
  });

  describe('backoff escalation and reset', () => {
    it('escalates backoff exponentially from base', async () => {
      const { _getResourceBackoffForTest, _escalateResourceBackoffForTest, _resetResourceBackoffForTest } =
        await import('../server/orchestrator/PtyManager.js');

      _resetResourceBackoffForTest();
      expect(_getResourceBackoffForTest()).toBe(0);

      _escalateResourceBackoffForTest();
      const first = _getResourceBackoffForTest();
      expect(first).toBeGreaterThan(0);

      _escalateResourceBackoffForTest();
      const second = _getResourceBackoffForTest();
      expect(second).toBeGreaterThanOrEqual(first * 2);
    });

    it('caps backoff at maximum', async () => {
      // Implementation in M5
    });

    it('resets backoff to zero', async () => {
      const { _getResourceBackoffForTest, _escalateResourceBackoffForTest, _resetResourceBackoffForTest } =
        await import('../server/orchestrator/PtyManager.js');

      _escalateResourceBackoffForTest();
      expect(_getResourceBackoffForTest()).toBeGreaterThan(0);

      _resetResourceBackoffForTest();
      expect(_getResourceBackoffForTest()).toBe(0);
    });
  });

  describe('session name generation', () => {
    it('generates deterministic session names', async () => {
      const { _getSessionNameForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'agent-123';
      const name = _getSessionNameForTest(agentId);
      expect(name).toBe(`orchestrator-${agentId}`);
    });
  });

  describe('state reset for tests', () => {
    it('_resetPtyManagerStateForTest clears all module state', async () => {
      const { _resetPtyManagerStateForTest, _getResourceBackoffForTest, _escalateResourceBackoffForTest } =
        await import('../server/orchestrator/PtyManager.js');

      _escalateResourceBackoffForTest();
      expect(_getResourceBackoffForTest()).toBeGreaterThan(0);

      _resetPtyManagerStateForTest();
      expect(_getResourceBackoffForTest()).toBe(0);
    });
  });

  describe('stale session identification', () => {
    it('exposes cleanup function for testing', async () => {
      const { _cleanupStaleTmuxSessionsForTest } = await import('../server/orchestrator/PtyManager.js');
      // Verify that the function can be called without error
      // Real cleanup logic tested in M6 with mocked tmux
      expect(() => _cleanupStaleTmuxSessionsForTest()).not.toThrow();
    });
  });

  // ─── statusFromNdjson ──────────────────────────────────────────────────────

  describe('statusFromNdjson', () => {
    let tmpDir: string;
    let logsDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-test-'));
      logsDir = path.join(tmpDir, 'agent-logs');
      fs.mkdirSync(logsDir, { recursive: true });
      // Point the AgentRunner LOGS_DIR to our temp dir by mocking getLogPath
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeNdjson(agentId: string, lines: object[]): string {
      const p = path.join(logsDir, `${agentId}.ndjson`);
      fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
      return p;
    }

    it('returns done when last result event has is_error=false', async () => {
      const { _statusFromNdjsonForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'test-agent-success';

      // Mock getLogPath to return our temp file
      const logPath = writeNdjson(agentId, [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [] } },
        { type: 'result', is_error: false, result: 'Done!', total_cost_usd: 0.01 },
      ]);

      vi.doMock('../server/orchestrator/AgentRunner.js', async (importOriginal) => {
        const original = await importOriginal<typeof import('../server/orchestrator/AgentRunner.js')>();
        return { ...original, getLogPath: (id: string) => path.join(logsDir, `${id}.ndjson`) };
      });

      // Since we can't easily re-mock an already-imported module mid-test,
      // test via _statusFromNdjsonForTest with a path that exists in process.cwd()/data/agent-logs.
      // Instead, write the file to the real logs dir location that AgentRunner uses.
      const { getLogPath } = await import('../server/orchestrator/AgentRunner.js');
      const realLogPath = getLogPath(agentId);
      fs.mkdirSync(path.dirname(realLogPath), { recursive: true });
      fs.writeFileSync(realLogPath, [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'assistant', message: { content: [] } }),
        JSON.stringify({ type: 'result', is_error: false, result: 'Done!', total_cost_usd: 0.01 }),
      ].join('\n') + '\n');

      try {
        const status = _statusFromNdjsonForTest(agentId);
        expect(status).toBe('done');
      } finally {
        try { fs.unlinkSync(realLogPath); } catch { /* ignore */ }
      }
    });

    it('returns failed when last result event has is_error=true', async () => {
      const { _statusFromNdjsonForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'test-agent-error';

      const { getLogPath } = await import('../server/orchestrator/AgentRunner.js');
      const realLogPath = getLogPath(agentId);
      fs.mkdirSync(path.dirname(realLogPath), { recursive: true });
      fs.writeFileSync(realLogPath, [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', is_error: true, error: 'Something went wrong' }),
      ].join('\n') + '\n');

      try {
        const status = _statusFromNdjsonForTest(agentId);
        expect(status).toBe('failed');
      } finally {
        try { fs.unlinkSync(realLogPath); } catch { /* ignore */ }
      }
    });

    it('returns null when no result event exists in the log', async () => {
      const { _statusFromNdjsonForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'test-agent-no-result';

      const { getLogPath } = await import('../server/orchestrator/AgentRunner.js');
      const realLogPath = getLogPath(agentId);
      fs.mkdirSync(path.dirname(realLogPath), { recursive: true });
      fs.writeFileSync(realLogPath, [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } }),
        // No result event — agent was killed mid-run
      ].join('\n') + '\n');

      try {
        const status = _statusFromNdjsonForTest(agentId);
        expect(status).toBeNull();
      } finally {
        try { fs.unlinkSync(realLogPath); } catch { /* ignore */ }
      }
    });

    it('returns null when log file does not exist', async () => {
      const { _statusFromNdjsonForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'test-agent-no-log-file';
      // Do not create the log file
      const status = _statusFromNdjsonForTest(agentId);
      expect(status).toBeNull();
    });

    it('skips malformed lines and finds result event in earlier lines', async () => {
      const { _statusFromNdjsonForTest } = await import('../server/orchestrator/PtyManager.js');
      const agentId = 'test-agent-malformed';

      const { getLogPath } = await import('../server/orchestrator/AgentRunner.js');
      const realLogPath = getLogPath(agentId);
      fs.mkdirSync(path.dirname(realLogPath), { recursive: true });
      // Last lines are malformed JSON; result event is earlier
      fs.writeFileSync(realLogPath, [
        JSON.stringify({ type: 'result', is_error: false, result: 'ok' }),
        'not-json-at-all',
        '{incomplete',
      ].join('\n') + '\n');

      try {
        const status = _statusFromNdjsonForTest(agentId);
        expect(status).toBe('done');
      } finally {
        try { fs.unlinkSync(realLogPath); } catch { /* ignore */ }
      }
    });
  });

  // ─── checkCommitsSince ─────────────────────────────────────────────────────

  describe('checkCommitsSince', () => {
    it('returns false when baseSha is null', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');
      expect(_checkCommitsSinceForTest(null, process.cwd())).toBe(false);
    });

    it('returns false when workDir is null', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');
      expect(_checkCommitsSinceForTest('abc123', null)).toBe(false);
    });

    it('returns false for a non-git directory', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
      try {
        expect(_checkCommitsSinceForTest('abc123', tmpDir2)).toBe(false);
      } finally {
        fs.rmSync(tmpDir2, { recursive: true, force: true });
      }
    });

    it('returns true when commits exist since baseSha', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');

      // Create a temp git repo with two commits
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-'));
      try {
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
        execFileSync('git', ['add', 'a.txt'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'first'], { cwd: repoDir, stdio: 'pipe' });
        const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

        fs.writeFileSync(path.join(repoDir, 'b.txt'), 'world');
        execFileSync('git', ['add', 'b.txt'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'second'], { cwd: repoDir, stdio: 'pipe' });

        expect(_checkCommitsSinceForTest(baseSha, repoDir)).toBe(true);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('returns false when no commits exist since baseSha (baseSha == HEAD)', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-empty-'));
      try {
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
        execFileSync('git', ['add', 'a.txt'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'first'], { cwd: repoDir, stdio: 'pipe' });
        const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

        // No additional commits — HEAD == baseSha
        expect(_checkCommitsSinceForTest(baseSha, repoDir)).toBe(false);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('returns false for an invalid baseSha (git command error)', async () => {
      const { _checkCommitsSinceForTest } = await import('../server/orchestrator/PtyManager.js');

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-repo-bad-sha-'));
      try {
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
        execFileSync('git', ['add', 'a.txt'], { cwd: repoDir, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'first'], { cwd: repoDir, stdio: 'pipe' });

        // Invalid SHA — git log will fail
        expect(_checkCommitsSinceForTest('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', repoDir)).toBe(false);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
