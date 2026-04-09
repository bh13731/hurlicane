import type { ClaudeStreamEvent, CodexStreamEvent } from '@shared/types';

/**
 * Render a Claude SDK stream event into terminal-friendly text with ANSI codes.
 */
export function renderEvent(event: ClaudeStreamEvent): string {
  switch (event.type) {
    case 'system': {
      const modelInfo = event.model ? ` | ${event.model}` : '';
      return `\x1b[36m[${event.subtype ?? 'system'}${modelInfo}]\x1b[0m\r\n`;
    }
    case 'assistant': {
      const content = event.message?.content ?? [];
      let out = '';
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          out += `\r\n${block.text}\r\n`;
        } else if (block.type === 'tool_use' && block.name) {
          const inputStr = block.input ? JSON.stringify(block.input) : '';
          const preview = inputStr.length > 120 ? inputStr.slice(0, 120) + '\u2026' : inputStr;
          out += `\r\n\x1b[2m\u2699 ${block.name}`;
          if (preview && preview !== '{}') out += `(${preview})`;
          out += `\x1b[0m\r\n`;
        }
      }
      return out;
    }
    case 'result': {
      if (event.is_error) {
        return `\r\n\x1b[31m\u2717 ${event.result || 'error'}\x1b[0m\r\n`;
      }
      return `\r\n\x1b[32m\u2713 Done\x1b[0m\r\n`;
    }
    case 'error':
      return `\x1b[31m\u2717 ${event.error?.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

/**
 * Check whether a parsed JSON event looks like a Codex (OpenAI) stream event.
 */
export function isCodexEvent(event: { type?: string }): boolean {
  return typeof event.type === 'string' && event.type.includes('.');
}

/**
 * Render a Codex (OpenAI) stream event into terminal-friendly text.
 */
export function renderCodexEvent(event: CodexStreamEvent): string {
  switch (event.type) {
    case 'thread.started':
      return `\x1b[36m[codex thread ${event.thread_id ?? ''}]\x1b[0m\r\n`;
    case 'item.completed': {
      const item = event.item;
      if (!item) return '';
      if (item.type === 'reasoning' && item.text) {
        return `\r\n\x1b[2m\x1b[3m${item.text}\x1b[0m\r\n`;
      }
      if (item.type === 'agent_message' && item.text) {
        return `\r\n${item.text}\r\n`;
      }
      if (item.type === 'command_execution') {
        let out = `\r\n\x1b[2m\u2699 ${item.command ?? 'command'}\x1b[0m\r\n`;
        if (item.aggregated_output) {
          const preview = item.aggregated_output.length > 500
            ? item.aggregated_output.slice(0, 500) + '\u2026'
            : item.aggregated_output;
          out += `\x1b[2m${preview}\x1b[0m\r\n`;
        }
        if (item.exit_code != null && item.exit_code !== 0) {
          out += `\x1b[31m(exit ${item.exit_code})\x1b[0m\r\n`;
        }
        return out;
      }
      return '';
    }
    case 'turn.completed':
      return `\r\n\x1b[32m\u2713 Done\x1b[0m\r\n`;
    case 'turn.failed':
      return `\r\n\x1b[31m\u2717 Turn failed${event.message ? ': ' + event.message : ''}\x1b[0m\r\n`;
    case 'error':
      return `\x1b[31m\u2717 ${event.error?.message ?? event.message ?? 'error'}\x1b[0m\r\n`;
    default:
      return '';
  }
}

/**
 * Parse a raw JSON string and route it to either Claude or Codex renderer.
 * Falls back to plain text if JSON parsing fails.
 */
export function renderAnyEvent(raw: string): string {
  try {
    const event = JSON.parse(raw);
    if (isCodexEvent(event)) {
      return renderCodexEvent(event as CodexStreamEvent);
    }
    return renderEvent(event as ClaudeStreamEvent);
  } catch {
    return raw + '\r\n';
  }
}

// ── LRU output cache ────────────────────────────────────────────────────────
const MAX_CACHE_SIZE = 50;
const renderedOutputCache = new Map<string, { text: string; truncated: boolean }>();

export function cacheGet(agentId: string): { text: string; truncated: boolean } | undefined {
  return renderedOutputCache.get(agentId);
}

export function cacheSet(agentId: string, entry: { text: string; truncated: boolean }): void {
  if (!entry.text) return;
  renderedOutputCache.delete(agentId);
  renderedOutputCache.set(agentId, entry);
  if (renderedOutputCache.size > MAX_CACHE_SIZE) {
    const oldest = renderedOutputCache.keys().next().value;
    if (oldest !== undefined) renderedOutputCache.delete(oldest);
  }
}
