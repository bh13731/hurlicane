/**
 * Tests for VerifyRunner — covers success, failure, timeout, and mixed output.
 * These tests run real child processes (echo/false/sleep) so they are fast and
 * deterministic without mocking exec.
 */
import { describe, it, expect } from 'vitest';
import { runVerification } from '../server/orchestrator/VerifyRunner.js';

describe('runVerification', () => {
  it('returns exitCode 0 and captures stdout on success', async () => {
    const result = await runVerification('echo hello', '/tmp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns non-zero exitCode on failure without throwing', async () => {
    const result = await runVerification('exit 1', '/tmp');
    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures non-zero exit code values correctly', async () => {
    const result = await runVerification('exit 42', '/tmp');
    expect(result.exitCode).toBe(42);
  });

  it('captures stderr output', async () => {
    const result = await runVerification('echo error-output >&2', '/tmp');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('error-output');
    expect(result.stdout).toBe('');
  });

  it('captures both stdout and stderr independently', async () => {
    const result = await runVerification('echo out-line; echo err-line >&2', '/tmp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('out-line');
    expect(result.stderr).toBe('err-line');
  });

  it('times out and returns exitCode 124 with sentinel message', async () => {
    const start = Date.now();
    const result = await runVerification('sleep 60', '/tmp', 200);
    const elapsed = Date.now() - start;

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('[verify] timed out after 200ms');
    // Should have resolved within a reasonable window of the timeout
    expect(elapsed).toBeLessThan(2000);
  });

  it('returns a non-zero exitCode for a non-existent command', async () => {
    const result = await runVerification('__nonexistent_command__xyz__', '/tmp');
    // Shell returns 127 for "command not found"; exec error paths may yield 1.
    // Either way the exit code must be non-zero.
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it('trims trailing whitespace from stdout and stderr', async () => {
    const result = await runVerification('printf "line1\n\n"', '/tmp');
    expect(result.stdout).toBe('line1');
  });

  it('respects cwd for the command', async () => {
    const result = await runVerification('pwd', '/tmp');
    // pwd output varies on macOS due to symlinks (/private/tmp vs /tmp)
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/tmp/);
  });
});
