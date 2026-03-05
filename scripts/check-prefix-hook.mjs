#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — enforces that all commits and GitHub
 * comments are prefixed with [BotName].
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

try {

// Crash-proof: any unhandled error → fail open
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

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
    // Strip surrounding brackets if present — user may have entered "[Name]"
    const raw = data.botName || '';
    return raw.replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

/**
 * Extract text content from a command, looking for the message/body.
 * Tries multiple patterns and returns the first match.
 */
function extractFlagValue(cmd, flags) {
  // flags is an array like ['-m'] or ['--body', '-b']
  const flagPattern = flags.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  // 1. Heredoc: flag "$(cat <<'DELIM'\n...\nDELIM\n)"
  const heredoc = cmd.match(new RegExp(`(?:${flagPattern})\\s+"\\$\\(cat\\s+<<'?\\w+'?[\\s\\S]*?\\n([\\s\\S]*?)\\n\\s*\\w+\\s*\\n?\\s*\\)"`));
  if (heredoc) return heredoc[1].trim();

  // 2. Double-quoted (but NOT heredoc — skip if starts with $()
  const dq = cmd.match(new RegExp(`(?:${flagPattern})\\s+"((?:[^"\\\\]|\\\\.)*)"`, 's'));
  if (dq) {
    const val = dq[1];
    // If this matched a heredoc wrapper like $(cat <<'EOF'...), extract inner content
    const innerHeredoc = val.match(/^\$\(cat\s+<<'?\w+'?\s*\n([\s\S]*?)\n\s*\w+\s*$/);
    if (innerHeredoc) return innerHeredoc[1].trim();
    return val;
  }

  // 3. Single-quoted
  const sq = cmd.match(new RegExp(`(?:${flagPattern})\\s+'((?:[^'\\\\]|\\\\.)*)'`));
  if (sq) return sq[1];

  // 4. Unquoted (rest of token until whitespace or next flag)
  const unquoted = cmd.match(new RegExp(`(?:${flagPattern})\\s+([^\\s"'-][^\\n]*)`));
  if (unquoted) return unquoted[1].trim();

  return null;
}

function block(msg) {
  // Write to stderr (Claude Code shows this to the agent on hook error).
  // Drain before exiting to ensure the message is flushed.
  process.stderr.write(msg, () => process.exit(2));
  // Fallback exit in case drain callback never fires
  setTimeout(() => process.exit(2), 500);
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

  const isCommit = /\bgit\s+commit\b/.test(command);
  const isComment = /\bgh\s+(pr|issue)\s+(comment|review)\b/.test(command);
  const isApiComment = /\bgh\s+api\b/.test(command) && /\b(comments|reviews)\b/.test(command) && /(-X\s+(POST|PUT|PATCH)|-f\s|-F\s|--field\s|--raw-field\s)/.test(command);

  if (!isCommit && !isComment && !isApiComment) process.exit(0);

  const botName = await getBotName();
  if (!botName) process.exit(0);

  const prefix = `[${botName}]`;

  if (isCommit) {
    const msg = extractFlagValue(command, ['-m']);
    if (msg === null) {
      return block(`Commit message must start with "${prefix}". Could not verify the message format.`);
    }
    if (!msg.trimStart().startsWith(prefix)) {
      return block(`Commit message must start with "${prefix}". Rewrite your commit message to begin with "${prefix} ".`);
    }
  }

  if (isComment || isApiComment) {
    // Try --body/-b first, then -f body= for gh api
    let body = extractFlagValue(command, ['--body', '-b']);
    if (body === null && isApiComment) {
      const apiField = command.match(/-f\s+body=["']?((?:[^"'\\]|\\.)*)["']?/);
      if (apiField) body = apiField[1];
    }
    if (body === null) {
      return block(`Comment/review body must start with "${prefix}". Could not verify the message format. Use --body "${prefix} ..." with your message.`);
    }
    if (!body.trimStart().startsWith(prefix)) {
      return block(`Comment/review body must start with "${prefix}". Rewrite your comment to begin with "${prefix} ".`);
    }
  }

  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  clearTimeout(debounce);
  debounce = setTimeout(() => processInput().catch(() => process.exit(0)), 30);
});
process.stdin.on('end', () => {
  clearTimeout(debounce);
  processInput().catch(() => process.exit(0));
});

} catch { process.exit(0); }
