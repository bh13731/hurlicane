import { spawn } from 'child_process';

/**
 * Call the local claude CLI with --print for a quick LLM completion.
 * Pipes the prompt via stdin to avoid shell escaping issues.
 * Returns the text response. Throws on failure.
 */
export function callClaude(prompt: string, opts?: { model?: string; maxTokens?: number; timeout?: number }): Promise<string> {
  const model = opts?.model ?? 'haiku';
  const timeout = opts?.timeout ?? 30_000;

  return new Promise((resolve, reject) => {
    const args = ['--print', '--model', model, '--no-session-persistence'];
    if (opts?.maxTokens) {
      args.push('--max-tokens', String(opts.maxTokens));
    }

    const proc = spawn('claude', args, { timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));

    proc.on('error', (err) => {
      reject(new Error(`claude CLI failed to start: ${err.message}`));
    });

    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString().trim();
      const stderr = Buffer.concat(errChunks).toString().trim();
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
        return;
      }
      resolve(stdout);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
