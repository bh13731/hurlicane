#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — prevents agents from switching branches
 * or committing to any branch other than their assigned worktree branch.
 *
 * Receives JSON on stdin (Claude Code hook protocol):
 *   { tool_name, tool_input: { command, ... } }
 *
 * Exit codes:
 *   0  — allow the tool call through
 *   2  — block it; stdout is shown to the agent as an error message
 */

// Crash-proof: any unhandled error → fail open
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// Only enforce inside orchestrator agent subprocesses.
const agentId = process.env.ORCHESTRATOR_AGENT_ID;
if (!agentId) process.exit(0);

// Safety valve: if no data arrives within 2s, fail open.
const noDataTimer = setTimeout(() => process.exit(0), 2000);

let input = '';
let debounce = null;

/**
 * Check if a shell command contains a branch-switching git operation.
 * Returns a block message if forbidden, or null if allowed.
 */
function checkCommand(command, assignedBranch) {
  // Normalise whitespace for easier matching
  const cmd = command.replace(/\s+/g, ' ').trim();

  // Split on shell operators to inspect each sub-command
  // Handles: &&, ||, ;, |, $(), backticks
  const parts = cmd.split(/&&|\|\||;|\||\$\(|`/);

  for (const part of parts) {
    const p = part.trim();

    // ── git checkout ──
    // Allow: git checkout -- <file>   (file restore)
    // Allow: git checkout <ref> -- <file>
    // Block: git checkout <branch>
    // Block: git checkout -b/-B <branch>
    if (/\bgit\s+checkout\b/.test(p)) {
      // File-restore mode: has " -- " separator
      if (/\bgit\s+checkout\b.*\s--\s/.test(p)) continue;

      // Creating a new branch: -b or -B flag
      if (/\bgit\s+checkout\s+-(b|B)\b/.test(p)) {
        return 'Branch creation via "git checkout -b" is not allowed. You must work on your assigned branch.';
      }

      // Extract the target after "git checkout [flags]"
      const target = p
        .replace(/.*\bgit\s+checkout\b/, '')
        .replace(/\s+-(f|q|-quiet|-force)\b/g, '')
        .trim();

      // If target is the assigned branch, allow (no-op switch)
      if (target === assignedBranch) continue;

      // If target looks like a file path (contains . or /), it's likely file restore
      // But without --, this is ambiguous. Be conservative and block.
      if (target && target !== assignedBranch) {
        return `Branch switching is not allowed. You are assigned to branch "${assignedBranch}". Use "git checkout -- <file>" to restore files.`;
      }
    }

    // ── git switch ──
    if (/\bgit\s+switch\b/.test(p)) {
      // Allow switching to the assigned branch (no-op)
      const target = p
        .replace(/.*\bgit\s+switch\b/, '')
        .replace(/\s+-(c|C|d|f|q|-create|-force-create|-detach|-quiet)\b/g, '')
        .trim();
      if (target === assignedBranch) continue;

      return `Branch switching via "git switch" is not allowed. You must work on your assigned branch "${assignedBranch}".`;
    }

    // ── git branch -m/-M (rename) ──
    if (/\bgit\s+branch\s+-(m|M|-move)\b/.test(p)) {
      return 'Renaming branches is not allowed.';
    }
  }

  return null; // all checks passed
}

async function processInput() {
  clearTimeout(noDataTimer);

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const command = data?.tool_input?.command;
  if (!command || typeof command !== 'string') process.exit(0);

  // Quick check: if the command doesn't contain any git branch-related keywords, skip.
  if (!/\bgit\s+(checkout|switch|branch\s+-(m|M))\b/.test(command)) {
    process.exit(0);
  }

  // Look up the agent's assigned branch
  const apiUrl = process.env.ORCHESTRATOR_API_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(
      `${apiUrl}/api/agents/${encodeURIComponent(agentId)}/branch`
    );
    if (!res.ok) process.exit(0); // API error → fail open
    const { branch } = await res.json();
    if (!branch) process.exit(0); // No worktree assigned → fail open

    const blockMsg = checkCommand(command, branch);
    if (blockMsg) {
      process.stdout.write(blockMsg);
      process.exit(2);
    }
    process.exit(0);
  } catch {
    process.exit(0); // network error → fail open
  }
}

function safeProcessInput() {
  processInput().catch(() => process.exit(0));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  clearTimeout(debounce);
  debounce = setTimeout(safeProcessInput, 30);
});
process.stdin.on('end', () => {
  clearTimeout(debounce);
  safeProcessInput();
});
