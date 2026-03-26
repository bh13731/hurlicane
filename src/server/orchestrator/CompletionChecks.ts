import { execSync } from 'child_process';
import * as queries from '../db/queries.js';
import type { Job, Agent } from '../../shared/types.js';

/**
 * Check whether the agent produced any git changes by looking at the cached diff
 * first, then falling back to a live git check against base_sha.
 */
function hasDiff(agent: Agent, job: Job): boolean {
  // Fast path: if the diff was already captured, trust it
  if (agent.diff && agent.diff.trim()) return true;

  // Fallback: run a live git check in case diff capture failed silently
  const agentRec = queries.getAgentById(agent.id);
  if (!agentRec?.base_sha) return false;
  try {
    const workDir = queries.resolveJobWorkDir(job);
    // --stat is lightweight and won't blow up maxBuffer on large diffs
    const stat = execSync(
      `git diff --stat ${agentRec.base_sha} HEAD`,
      { cwd: workDir, timeout: 10000 }
    ).toString().trim();
    if (stat) return true;
    // Also check for uncommitted changes
    const uncommitted = execSync(
      'git diff --stat HEAD',
      { cwd: workDir, timeout: 10000 }
    ).toString().trim();
    return !!uncommitted;
  } catch {
    return false;
  }
}

/**
 * Runs completion checks configured on a job after the agent reports success.
 * Returns null if all checks pass, or an error string describing failures.
 */
export function runCompletionChecks(job: Job, agent: Agent): string | null {
  if (!job.completion_checks) return null;

  let checks: string[];
  try {
    checks = JSON.parse(job.completion_checks);
  } catch {
    return null;
  }
  if (!Array.isArray(checks) || checks.length === 0) return null;

  const failures: string[] = [];

  for (const check of checks) {
    if (check === 'diff_not_empty') {
      if (!hasDiff(agent, job)) {
        failures.push('diff_not_empty: agent produced no git changes');
      }
    } else if (check === 'no_error_in_output') {
      const hasError = checkForErrorEvents(agent.id);
      if (hasError) {
        failures.push('no_error_in_output: error events found in agent output');
      }
    } else if (check.startsWith('custom_command:')) {
      const cmd = check.slice('custom_command:'.length).trim();
      if (cmd) {
        const result = runCustomCommand(cmd, job);
        if (result) {
          failures.push(`custom_command: ${result}`);
        }
      }
    }
  }

  return failures.length > 0 ? failures.join('; ') : null;
}

function checkForErrorEvents(agentId: string): boolean {
  const output = queries.getAgentOutput(agentId);
  // Check last 20 output rows for error events
  const last20 = output.slice(-20);
  for (const row of last20) {
    try {
      const ev = JSON.parse(row.content);
      if (ev.type === 'error') return true;
    } catch { /* skip */ }
  }
  return false;
}

function runCustomCommand(cmd: string, job: Job): string | null {
  const workDir = queries.resolveJobWorkDir(job);
  try {
    execSync(cmd, { cwd: workDir, timeout: 30_000, stdio: 'pipe' });
    return null; // exit 0 = pass
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim() ?? '';
    const msg = stderr.slice(0, 200) || `command exited with code ${err.status ?? 'unknown'}`;
    return msg;
  }
}
