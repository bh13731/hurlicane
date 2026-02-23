import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import type { Job, Debate, DebateRole } from '../../shared/types.js';

/**
 * Called from AgentRunner.handleAgentExit after a job's status is finalized.
 * If the job belongs to a debate, checks whether the current round is complete
 * and either advances to the next round or finalizes the debate.
 */
export function onJobCompleted(job: Job): void {
  if (!job.debate_id) return;

  try {
    _onJobCompleted(job);
  } catch (err) {
    console.error(`[debate] error handling job completion for job ${job.id}:`, err);
  }
}

function _onJobCompleted(job: Job): void {
  const debate = queries.getDebateById(job.debate_id!);
  if (!debate) return;

  // Phase: post-action job completed → maybe spawn verification review
  if (job.debate_role === 'post_action') {
    if (job.status === 'done' && debate.post_action_verification) {
      const agentId = getAgentIdForJob(job.id);
      const postActionResult = agentId ? queries.getAgentResultText(agentId) : null;
      spawnVerificationReview(debate, postActionResult);
    }
    return;
  }

  // Phase: verification review completed → spawn verification response
  if (job.debate_role === 'verification_review') {
    if (job.status === 'done') {
      const reviewAgentId = getAgentIdForJob(job.id);
      const reviewResult = reviewAgentId ? queries.getAgentResultText(reviewAgentId) : null;
      const postActionAgentId = debate.post_action_job_id ? getAgentIdForJob(debate.post_action_job_id) : null;
      const postActionResult = postActionAgentId ? queries.getAgentResultText(postActionAgentId) : null;
      spawnVerificationResponse(debate, reviewResult, postActionResult);
    }
    return;
  }

  // Phase: verification response completed — cycle complete, nothing more to do
  if (job.debate_role === 'verification_response') return;

  // Debate round handling — only while debate is still running
  if (debate.status !== 'running') return;

  // If this job failed, mark the whole debate as failed
  if (job.status === 'failed' || job.status === 'cancelled') {
    const updated = queries.updateDebate(debate.id, { status: 'failed' });
    if (updated) {
      socket.emitDebateUpdate(updated);
      maybeSpawnPostAction(updated, null, null);
    }
    console.log(`[debate ${debate.id}] marked failed due to job ${job.id} (${job.status})`);
    return;
  }

  // Check if both sides of the current round are done
  const roundJobs = queries.getJobsForDebateRound(debate.id, debate.current_round);
  const allDone = roundJobs.length === 2 && roundJobs.every(j => j.status === 'done');
  if (!allDone) return;

  // Extract results from both sides
  const claudeJob = roundJobs.find(j => j.debate_role === 'claude');
  const codexJob = roundJobs.find(j => j.debate_role === 'codex');
  if (!claudeJob || !codexJob) return;

  const claudeAgentId = getAgentIdForJob(claudeJob.id);
  const claudeResult = claudeAgentId ? queries.getAgentResultText(claudeAgentId) : null;
  const codexAgentId = getAgentIdForJob(codexJob.id);
  const codexResult = codexAgentId ? queries.getAgentResultText(codexAgentId) : null;

  // Check for consensus
  const claudeVerdict = parseVerdict(claudeResult);
  const codexVerdict = parseVerdict(codexResult);

  if (detectConsensus(claudeVerdict, codexVerdict)) {
    const summary = claudeVerdict?.summary || codexVerdict?.summary || 'Both sides agreed.';
    const updated = queries.updateDebate(debate.id, {
      status: 'consensus',
      consensus: JSON.stringify({ summary, round: debate.current_round }),
    });
    if (updated) {
      socket.emitDebateUpdate(updated);
      maybeSpawnPostAction(updated, claudeResult, codexResult);
    }
    console.log(`[debate ${debate.id}] consensus reached at round ${debate.current_round}`);
    return;
  }

  // Check if we've hit max rounds
  const nextRound = debate.current_round + 1;
  if (nextRound >= debate.max_rounds) {
    const updated = queries.updateDebate(debate.id, { status: 'disagreement' });
    if (updated) {
      socket.emitDebateUpdate(updated);
      maybeSpawnPostAction(updated, claudeResult, codexResult);
    }
    console.log(`[debate ${debate.id}] max rounds reached, disagreement`);
    return;
  }

  // Create next discussion round
  createDiscussionRound(debate, nextRound, claudeResult, codexResult);
}

function getAgentIdForJob(jobId: string): string | null {
  const agents = queries.getAgentsWithJobByJobId(jobId);
  // Return the last agent for this job (most recent attempt)
  return agents.length > 0 ? agents[0].id : null;
}

function createDiscussionRound(
  debate: Debate,
  round: number,
  claudePrevResult: string | null,
  codexPrevResult: string | null,
): void {
  // Update debate current_round
  queries.updateDebate(debate.id, { current_round: round });

  const claudePrompt = buildDiscussionPrompt(debate, 'claude', round, claudePrevResult, codexPrevResult);
  const codexPrompt = buildDiscussionPrompt(debate, 'codex', round, codexPrevResult, claudePrevResult);

  const claudeJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate R${round}] Claude`,
    description: claudePrompt,
    context: null,
    priority: 0,
    model: debate.claude_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_round: round,
    debate_role: 'claude',
  });

  const codexJob = queries.insertJob({
    id: randomUUID(),
    title: `[Debate R${round}] Codex`,
    description: codexPrompt,
    context: null,
    priority: 0,
    model: debate.codex_model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_round: round,
    debate_role: 'codex',
  });

  socket.emitJobNew(claudeJob);
  socket.emitJobNew(codexJob);

  const updated = queries.getDebateById(debate.id);
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] created round ${round} jobs: claude=${claudeJob.id.slice(0, 8)} codex=${codexJob.id.slice(0, 8)}`);
}

export function buildInitialPrompt(debate: Debate): string {
  return `# Debate Task

You are participating in a structured debate. Analyze the following task thoroughly and provide your assessment.

## Task
${debate.task}

## Instructions
1. Analyze the task carefully and provide your assessment, recommendations, or solution.
2. Be thorough and specific in your analysis.
3. At the END of your response, you MUST include a consensus block in exactly this format:

\`\`\`consensus
{"verdict": "disagree", "summary": "Brief summary of your position"}
\`\`\`

For the first round, always use "disagree" as the verdict since you haven't seen the other side's analysis yet.
The summary should be a concise (1-2 sentence) description of your key position.`;
}

function buildDiscussionPrompt(
  debate: Debate,
  role: DebateRole,
  round: number,
  ownPrevResult: string | null,
  otherPrevResult: string | null,
): string {
  const otherSide = role === 'claude' ? 'Codex' : 'Claude';

  return `# Debate Task — Round ${round} Discussion

You are participating in a structured debate (round ${round} of max ${debate.max_rounds}).

## Original Task
${debate.task}

## Your Previous Analysis
${ownPrevResult ?? '(No previous analysis available)'}

## ${otherSide}'s Previous Analysis
${otherPrevResult ?? '(No analysis available from the other side)'}

## Instructions for This Round
1. Review both analyses carefully.
2. Identify points of agreement and disagreement.
3. Refine your position based on the other side's arguments — update if they made good points.
4. Propose specific resolutions for any remaining disagreements.
5. At the END of your response, you MUST include a consensus block:

\`\`\`consensus
{"verdict": "agree"|"disagree"|"partial", "summary": "Brief summary of your current position"}
\`\`\`

Use "agree" if you fully agree with the other side's analysis and your positions have converged.
Use "partial" if you agree on most points but have remaining minor differences.
Use "disagree" if there are significant unresolved differences.`;
}

interface Verdict {
  verdict: 'agree' | 'disagree' | 'partial';
  summary: string;
}

export function parseVerdict(resultText: string | null): Verdict | null {
  if (!resultText) return null;

  // Look for ```consensus ... ``` block
  const pattern = /```consensus\s*\n?([\s\S]*?)\n?\s*```/;
  const match = resultText.match(pattern);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (parsed.verdict && typeof parsed.summary === 'string') {
      return {
        verdict: parsed.verdict as Verdict['verdict'],
        summary: parsed.summary,
      };
    }
  } catch { /* malformed JSON */ }

  return null;
}

function detectConsensus(a: Verdict | null, b: Verdict | null): boolean {
  // Both must explicitly say "agree"
  return a?.verdict === 'agree' && b?.verdict === 'agree';
}

function maybeSpawnPostAction(
  debate: Debate,
  claudeResult: string | null,
  codexResult: string | null,
): void {
  if (!debate.post_action_prompt || !debate.post_action_role) return;

  const model = debate.post_action_role === 'claude' ? debate.claude_model : debate.codex_model;
  const prompt = buildPostActionPrompt(debate, claudeResult, codexResult);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Post-Debate] ${debate.title.slice(0, 50)}`,
    description: prompt,
    context: null,
    priority: 0,
    model,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    is_interactive: 1,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_round: null,
    debate_role: 'post_action',
  });

  socket.emitJobNew(job);

  const updated = queries.updateDebate(debate.id, { post_action_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned post-action job ${job.id.slice(0, 8)} (model: ${model})`);
}

function spawnVerificationReview(debate: Debate, postActionResult: string | null): void {
  if (!debate.post_action_role) return;

  // The reviewer is the OTHER model
  const reviewerRole: DebateRole = debate.post_action_role === 'claude' ? 'codex' : 'claude';
  const reviewerModel = reviewerRole === 'claude' ? debate.claude_model : debate.codex_model;
  const implementerLabel = debate.post_action_role === 'claude' ? 'Claude' : 'Codex';

  const prompt = buildVerificationReviewPrompt(debate, postActionResult, implementerLabel);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Verification Review] ${debate.title.slice(0, 40)}`,
    description: prompt,
    context: null,
    priority: 0,
    model: reviewerModel,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    is_interactive: 1,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_round: null,
    debate_role: 'verification_review',
  });

  socket.emitJobNew(job);

  const updated = queries.updateDebate(debate.id, { verification_review_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned verification review job ${job.id.slice(0, 8)} (reviewer: ${reviewerModel})`);
}

function spawnVerificationResponse(
  debate: Debate,
  reviewResult: string | null,
  postActionResult: string | null,
): void {
  if (!debate.post_action_role) return;

  const implementerModel = debate.post_action_role === 'claude' ? debate.claude_model : debate.codex_model;
  const reviewerLabel = debate.post_action_role === 'claude' ? 'Codex' : 'Claude';

  const prompt = buildVerificationResponsePrompt(debate, reviewResult, postActionResult, reviewerLabel);

  const job = queries.insertJob({
    id: randomUUID(),
    title: `[Verification Response] ${debate.title.slice(0, 37)}`,
    description: prompt,
    context: null,
    priority: 0,
    model: implementerModel,
    template_id: debate.template_id,
    work_dir: debate.work_dir,
    max_turns: debate.max_turns,
    is_interactive: 1,
    project_id: debate.project_id,
    debate_id: debate.id,
    debate_round: null,
    debate_role: 'verification_response',
  });

  socket.emitJobNew(job);

  const updated = queries.updateDebate(debate.id, { verification_response_job_id: job.id });
  if (updated) socket.emitDebateUpdate(updated);

  console.log(`[debate ${debate.id}] spawned verification response job ${job.id.slice(0, 8)} (implementer: ${implementerModel})`);
}

function buildVerificationReviewPrompt(
  debate: Debate,
  postActionResult: string | null,
  implementerLabel: string,
): string {
  const statusLabel =
    debate.status === 'consensus' ? 'Consensus reached' :
    debate.status === 'disagreement' ? 'Max rounds reached without full agreement' :
    'Debate ended';

  const consensusSummary = (() => {
    if (!debate.consensus) return null;
    try { return (JSON.parse(debate.consensus) as any).summary ?? null; } catch { return null; }
  })();

  let prompt = `# Verification Review\n\n`;
  prompt += `Your role is to review the implementation done by ${implementerLabel} after a collaborative debate.\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Debate Outcome\n${statusLabel}.\n`;
  if (consensusSummary) prompt += `**Summary:** ${consensusSummary}\n`;
  prompt += `\n`;
  prompt += `## Implementation Done by ${implementerLabel}\n`;
  prompt += postActionResult ?? '(No implementation output available)';
  prompt += `\n\n`;
  prompt += `## Your Review\n`;
  prompt += `Please review the implementation above. Provide constructive feedback on:\n`;
  prompt += `1. **Correctness** — does the implementation address the task properly?\n`;
  prompt += `2. **Completeness** — is anything missing or incomplete?\n`;
  prompt += `3. **Quality** — any improvements you would suggest?\n\n`;
  prompt += `Be specific and actionable. Highlight what was done well, then clearly describe any concerns or improvements needed.`;
  return prompt;
}

function buildVerificationResponsePrompt(
  debate: Debate,
  reviewResult: string | null,
  postActionResult: string | null,
  reviewerLabel: string,
): string {
  let prompt = `# Implementation Review Response\n\n`;
  prompt += `You previously implemented a solution after a collaborative debate. ${reviewerLabel} has reviewed your work and provided feedback.\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Your Previous Implementation\n`;
  prompt += postActionResult ?? '(No implementation output available)';
  prompt += `\n\n`;
  prompt += `## ${reviewerLabel}'s Feedback\n`;
  prompt += reviewResult ?? '(No feedback available)';
  prompt += `\n\n`;
  prompt += `## Your Action\n`;
  prompt += `Review the feedback above. Make any changes to your implementation that you agree with or find valuable. `;
  prompt += `If you disagree with specific feedback, you may skip it — but only if you have a clear reason. `;
  prompt += `Focus on improving the implementation based on the constructive feedback provided.`;
  return prompt;
}

function buildPostActionPrompt(
  debate: Debate,
  claudeResult: string | null,
  codexResult: string | null,
): string {
  const statusLabel =
    debate.status === 'consensus' ? 'Consensus reached' :
    debate.status === 'disagreement' ? 'Max rounds reached without full agreement' :
    'Debate ended';

  const consensusSummary = (() => {
    if (!debate.consensus) return null;
    try { return (JSON.parse(debate.consensus) as any).summary ?? null; } catch { return null; }
  })();

  let prompt = `# Post-Debate Action\n\n`;
  prompt += `## Original Task\n${debate.task}\n\n`;
  prompt += `## Debate Outcome\n${statusLabel}.\n`;
  if (consensusSummary) prompt += `**Summary:** ${consensusSummary}\n`;
  prompt += `\n`;

  if (claudeResult) {
    prompt += `## Claude's Final Analysis\n${claudeResult}\n\n`;
  }
  if (codexResult) {
    prompt += `## Codex's Final Analysis\n${codexResult}\n\n`;
  }

  prompt += `## Your Action\n${debate.post_action_prompt}`;
  return prompt;
}
