import type { EyeConfig } from './config.js';
import type { OrchestratorClient } from './orchestrator.js';
import type { CreateJobRequest } from '../src/shared/types.js';
import { extractSignals, evaluateComplexity, parseComplexityConfig } from './complexity.js';
import { resolveWorktree } from './worktree.js';

export interface ProcessEventResult {
  type: 'job' | 'debate' | 'skipped';
  title: string;
}

/**
 * Build a concise summary of the event for the LLM skip evaluator.
 */
function summarizeEvent(eventType: string, payload: any, jobReq: CreateJobRequest): string {
  const repo = payload.repository?.full_name ?? '';
  const action = payload.action ?? '';
  const sender = payload.sender?.login ?? '';
  const pr = payload.pull_request ?? payload.issue ?? {};
  const draft = pr.draft ? 'DRAFT' : 'not draft';
  const prNum = pr.number ?? '';
  const prTitle = pr.title ?? '';
  const branch = jobReq.context?.branch ?? '';

  return [
    `Event: ${eventType} (action: ${action})`,
    `Repo: ${repo}`,
    `Sender: ${sender}`,
    `PR #${prNum}: "${prTitle}" [${draft}]`,
    branch ? `Branch: ${branch}` : '',
    `Job title: ${jobReq.title ?? ''}`,
    `Job description: ${jobReq.description.slice(0, 500)}`,
  ].filter(Boolean).join('\n');
}

/**
 * Use the local claude CLI to evaluate whether this event should be skipped
 * based on the user's skip prompt.
 */
async function llmShouldSkip(
  skipPrompt: string,
  eventSummary: string,
): Promise<string | null> {
  try {
    const { execFile } = await import('child_process');
    const prompt = `You are a GitHub event filter. Based on the skip rules and the event, decide whether to SKIP or PROCESS this event.

## Skip Rules
${skipPrompt}

## Event
${eventSummary}

Reply with exactly one word: SKIP or PROCESS`;

    const { spawn } = await import('child_process');
    const answer = await new Promise<string>((resolve, reject) => {
      const proc = spawn('claude', ['--print', '--model', 'haiku', '--no-session-persistence'], {
        timeout: 15_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
      proc.on('error', (err: Error) => reject(new Error(`claude CLI failed: ${err.message}`)));
      proc.on('close', (code: number | null) => {
        const out = Buffer.concat(chunks).toString().trim();
        const errOut = Buffer.concat(errChunks).toString().trim();
        if (code !== 0) { reject(new Error(`claude CLI exited ${code}${errOut ? `\n${errOut}` : ''}`)); return; }
        resolve(out);
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    });

    if (answer.toUpperCase().includes('SKIP')) {
      return `LLM skip: matched rule "${skipPrompt.slice(0, 80)}"`;
    }
    return null;
  } catch (err: any) {
    console.warn(`[eye] skip LLM evaluation failed: ${err.message}`);
    return null; // on error, allow through
  }
}

/**
 * Check whether this event should be skipped entirely.
 * Runs before complexity evaluation.
 */
async function shouldSkip(
  client: OrchestratorClient,
  repoName: string,
  skipPrompt: string,
  eventSummary: string,
): Promise<string | null> {
  if (!repoName) return 'no repo in payload';

  // Default: skip if repo isn't registered in the orchestrator
  const repo = await client.getRepoByName(repoName);
  if (!repo) return `repo "${repoName}" not registered`;

  // Evaluate skip prompt via LLM
  if (skipPrompt.trim()) {
    const llmResult = await llmShouldSkip(skipPrompt, eventSummary);
    if (llmResult) return llmResult;
  }

  return null;
}

/**
 * Takes a CreateJobRequest from a handler, resolves worktree, evaluates
 * complexity, then dispatches as either a simple job or a debate.
 */
export async function processEvent(
  client: OrchestratorClient,
  config: EyeConfig,
  eventType: string,
  payload: any,
  jobReq: CreateJobRequest,
): Promise<ProcessEventResult | null> {
  const repoName = payload.repository?.full_name ?? '';
  const branch = jobReq.context?.branch ?? '';

  console.log(`[eye] processEvent: ${eventType} repo=${repoName} branch="${branch}"`);

  // ── Fetch configurable prompts ──
  const prompts = await client.getPrompts();

  // ── Skip filter (before complexity evaluation) ──
  const eventSummary = summarizeEvent(eventType, payload, jobReq);
  const skipReason = await shouldSkip(client, repoName, prompts.skipPrompt, eventSummary);
  if (skipReason) {
    console.log(`[eye] skipping ${eventType}: ${skipReason}`);
    return { type: 'skipped', title: skipReason };
  }

  // Resolve worktree for branch isolation
  const wt = await resolveWorktree(client, repoName, branch);
  if (wt) {
    console.log(`[eye] worktree resolved: ${wt.workDir} (branch: ${wt.branch}, new: ${wt.isNew})`);
    jobReq.workDir = wt.workDir;
  } else {
    console.log(`[eye] no worktree resolved for branch="${branch}"`);
  }

  // Evaluate complexity with configurable thresholds
  const signals = extractSignals(eventType, payload);
  const complexityConfig = parseComplexityConfig(prompts.discussionPrompt);
  const complexity = evaluateComplexity(signals, complexityConfig);

  if (complexity === 'debate') {
    const result = await client.createDebate({
      title: jobReq.title ?? `Debate: ${jobReq.description.slice(0, 40)}`,
      task: jobReq.description,
      claudeModel: 'sonnet',
      codexModel: 'codex',
      maxRounds: 3,
      workDir: jobReq.workDir,
      postActionPrompt: 'Implement the agreed solution from the debate.',
      postActionRole: 'claude',
    });
    if (!result) return null;
    return { type: 'debate', title: result.debate.title };
  }

  // Simple job
  const result = await client.createJob(jobReq);
  if (!result) return null;
  return { type: 'job', title: result.title };
}
