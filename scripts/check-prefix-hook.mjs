#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — enforces that all commits and GitHub
 * comments made by orchestrator agents are prefixed with [BotName].
 *
 * Reads the bot name from the orchestrator API (setting:botName).
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

/** Fetch the configured bot name from the orchestrator API. */
async function getBotName() {
  const apiUrl = process.env.ORCHESTRATOR_API_URL ?? 'http://localhost:3000';
  try {
    const res = await fetch(`${apiUrl}/api/settings`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.botName || null;
  } catch {
    return null;
  }
}

/**
 * Extract the commit message from a git commit command string.
 * Handles: -m "msg", -m 'msg', -m msg, and heredoc patterns.
 */
function extractCommitMessage(cmd) {
  // Match -m followed by a quoted or unquoted string
  // Handle: -m "msg", -m 'msg', -m msg
  const doubleQuote = cmd.match(/\bgit\s+commit\b.*?-m\s+"((?:[^"\\]|\\.)*)"/);
  if (doubleQuote) return doubleQuote[1];

  const singleQuote = cmd.match(/\bgit\s+commit\b.*?-m\s+'((?:[^'\\]|\\.)*)'/);
  if (singleQuote) return singleQuote[1];

  // Heredoc pattern: -m "$(cat <<'EOF'\n...\nEOF\n)"
  const heredoc = cmd.match(/\bgit\s+commit\b.*?-m\s+"\$\(cat\s+<<'?EOF'?\s*\n([\s\S]*?)\nEOF/);
  if (heredoc) return heredoc[1].trim();

  // Unquoted: -m followed by non-whitespace
  const unquoted = cmd.match(/\bgit\s+commit\b.*?-m\s+(\S+)/);
  if (unquoted) return unquoted[1];

  return null;
}

/**
 * Extract the body from a gh comment command.
 * Handles: --body "msg", --body 'msg', -b "msg", -b 'msg', heredoc patterns.
 */
function extractCommentBody(cmd) {
  // --body or -b with double quotes
  const dq = cmd.match(/(?:--body|-b)\s+"((?:[^"\\]|\\.)*)"/);
  if (dq) return dq[1];

  // --body or -b with single quotes
  const sq = cmd.match(/(?:--body|-b)\s+'((?:[^'\\]|\\.)*)'/);
  if (sq) return sq[1];

  // Heredoc pattern
  const heredoc = cmd.match(/(?:--body|-b)\s+"\$\(cat\s+<<'?EOF'?\s*\n([\s\S]*?)\nEOF/);
  if (heredoc) return heredoc[1].trim();

  return null;
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

  // Quick check: does this command involve a commit or gh comment?
  const isCommit = /\bgit\s+commit\b/.test(command);
  const isComment = /\bgh\s+(pr|issue)\s+(comment|review)\b/.test(command);

  if (!isCommit && !isComment) process.exit(0);

  const botName = await getBotName();
  if (!botName) process.exit(0); // no name configured → skip enforcement

  const prefix = `[${botName}]`;

  if (isCommit) {
    const msg = extractCommitMessage(command);
    if (msg !== null && !msg.trimStart().startsWith(prefix)) {
      process.stdout.write(
        `Commit message must start with "${prefix}". Rewrite your commit message to begin with "${prefix} ".`
      );
      process.exit(2);
    }
  }

  if (isComment) {
    const body = extractCommentBody(command);
    if (body !== null && !body.trimStart().startsWith(prefix)) {
      process.stdout.write(
        `Comment body must start with "${prefix}". Rewrite your comment to begin with "${prefix} ".`
      );
      process.exit(2);
    }
  }

  process.exit(0);
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
