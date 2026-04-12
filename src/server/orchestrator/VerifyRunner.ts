import { exec } from 'child_process';
// Verify runner - executes shell commands for workflow verification

export interface VerifyResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Run a shell command as a live-verification step.
 *
 * - Runs in `cwd` with the parent process env (so Doppler/shell secrets are available).
 * - Captures stdout and stderr separately.
 * - Returns a structured result regardless of exit code; never rejects on non-zero exit.
 * - On timeout the child is killed, exitCode is normalised to 124 (matching the GNU
 *   `timeout` convention), and a sentinel message is prepended to stderr.
 *
 * exec() is used intentionally here: the verify command is a user-configured shell
 * command that may include pipes, semicolons, and other shell features (e.g.
 * `doppler run -- npx tsx scripts/smoke-test.ts`).  The command is always stored in
 * the workflow's verify_command column and is not constructed from runtime input.
 */
export async function runVerification(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerifyResult> {
  const start = Date.now();

  return new Promise<VerifyResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const child = (exec as any)(command, {
      cwd,
      env: process.env,
      // Do NOT pass `timeout` to exec — it kills via SIGKILL but the 'close'
      // event arrives with code=null and no clean signal name.  We manage the
      // timeout ourselves below so we can set timedOut before resolve().
      maxBuffer: 10 * 1024 * 1024, // 10 MB cap per stream
    });

    let timer: ReturnType<typeof setTimeout> | null = null;

    function finish(exitCode: number, extra?: string) {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.trimEnd(),
        stderr: extra ? (extra + '\n' + stderr).trimEnd() : stderr.trimEnd(),
        durationMs: Date.now() - start,
      });
    }

    // Timeout management: kill the child and resolve with exitCode 124.
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 3000);
      finish(124, `[verify] timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });

    child.on('error', (err: Error) => {
      if (!timedOut) {
        finish(1, String(err));
      }
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (timedOut) return; // already resolved
      const exitCode = code !== null ? code : (signal ? 1 : 0);
      finish(exitCode);
    });
  });
}
