import { spawn } from 'child_process';

const MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20250514',
  opus: 'claude-opus-4-6-20250514',
};

/**
 * Call the Anthropic API directly for a quick LLM completion.
 * Falls back to the claude CLI if ANTHROPIC_API_KEY is not set.
 * Returns the text response. Throws on failure.
 */
export async function callClaude(prompt: string, opts?: { model?: string; maxTokens?: number; timeout?: number }): Promise<string> {
  const model = opts?.model ?? 'haiku';
  const maxTokens = opts?.maxTokens ?? 1024;
  const timeout = opts?.timeout ?? 15_000;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    const resolvedModel = MODEL_MAP[model] ?? model;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json() as any;
    return (data.content?.[0]?.text ?? '').trim();
  }

  // Fallback: spawn claude CLI (slow, but works without API key)
  return new Promise((resolve, reject) => {
    const args = ['--print', '--model', model, '--no-session-persistence'];
    const proc = spawn('claude', args, { timeout: timeout + 20_000, stdio: ['pipe', 'pipe', 'pipe'] });
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
