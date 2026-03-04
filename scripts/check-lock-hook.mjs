#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — enforces file locks before any edit.
 *
 * Receives JSON on stdin (Claude Code hook protocol):
 *   { tool_name, tool_input: { file_path, ... } }
 *
 * Exit codes:
 *   0  — allow the tool call through
 *   2  — block it; stdout is shown to the agent as an error message
 *
 * NOTE: Claude Code does not close the hook's stdin (neither for the main
 * instance nor for agent subprocesses). We use a short debounce timer
 * after the last data chunk rather than waiting for the 'end' event.
 */
import { resolve } from 'path';

// Crash-proof: any unhandled error → fail open
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// Fast path: only enforce inside orchestrator agent subprocesses.
const agentId = process.env.ORCHESTRATOR_AGENT_ID;
if (!agentId) process.exit(0);

// Readonly agents are unconditionally blocked from all file edits.
if (process.env.ORCHESTRATOR_READONLY === 'true') {
  process.stdout.write('This is a read-only job. File modifications are not allowed.');
  process.exit(2);
}

// Safety valve: if no data arrives within 2s, fail open.
const noDataTimer = setTimeout(() => process.exit(0), 2000);

let input = '';
let debounce = null;

async function processInput() {
  clearTimeout(noDataTimer);

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const tool_input = data?.tool_input;

  // All writable tools expose the target path as file_path or notebook_path.
  const rawPath = tool_input?.file_path ?? tool_input?.notebook_path;
  if (!rawPath) process.exit(0);

  // Resolve relative paths against cwd so the lock check is unambiguous
  const filePath = rawPath.startsWith('/') ? rawPath : resolve(process.cwd(), rawPath);

  const apiUrl = process.env.ORCHESTRATOR_API_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(
      `${apiUrl}/api/locks/check?agent_id=${encodeURIComponent(agentId)}&file=${encodeURIComponent(filePath)}`
    );
    if (!res.ok) process.exit(0); // API error → fail open
    const { locked } = await res.json();
    if (locked) {
      process.exit(0); // lock held — allow the edit
    } else {
      process.stdout.write(
        `Lock required: call lock_files(["${filePath}"], "<reason>") before editing this file.`
      );
      process.exit(2); // block and show message to agent
    }
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
  // Process 30ms after the last chunk — stdin won't close in agent mode
  clearTimeout(debounce);
  debounce = setTimeout(safeProcessInput, 30);
});
// Handle proper stdin close (manual testing, CI, etc.)
process.stdin.on('end', () => {
  clearTimeout(debounce);
  safeProcessInput();
});
