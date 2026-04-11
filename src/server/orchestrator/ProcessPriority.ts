import { execFileSync } from 'child_process';

const NICE_BIN = process.env.NICE_BIN ?? 'nice';

let _niceAvailable: boolean | null = null;

export function isNiceAvailable(): boolean {
  if (_niceAvailable != null) return _niceAvailable;
  try {
    // Probe with the same PATH resolution that `spawn()` will use later,
    // rather than a login-shell `command -v` lookup that can see a richer
    // PATH than Node's child_process sees. Previously the `/bin/sh -lc`
    // probe succeeded (login shell PATH had nice) but the subsequent
    // `spawn('nice', ...)` failed with ENOENT (Node's PATH didn't).
    // See HURLICANE-1E. `nice -n 0 true` is portable across GNU/BSD nice.
    execFileSync(NICE_BIN, ['-n', '0', 'true'], {
      stdio: 'ignore',
      timeout: 3000,
    });
    _niceAvailable = true;
  } catch {
    /* ENOENT (binary not on Node's PATH) or non-zero exit — either way,
       fall back to plain spawn without priority adjustment. */
    _niceAvailable = false;
  }
  return _niceAvailable;
}

export function buildNiceSpawn(binary: string, args: string[]): { command: string; args: string[] } {
  if (!isNiceAvailable()) {
    return { command: binary, args };
  }
  return { command: NICE_BIN, args: ['-n', '10', binary, ...args] };
}

export function wrapExecLineWithNice(execLine: string): string {
  if (!isNiceAvailable()) return execLine;
  return execLine.startsWith('exec ')
    ? `exec ${JSON.stringify(NICE_BIN)} -n 10 ${execLine.slice(5)}`
    : `${JSON.stringify(NICE_BIN)} -n 10 ${execLine}`;
}

export function _resetForTest(): void {
  _niceAvailable = null;
}
