import { randomBytes } from 'crypto';
import * as queries from '../db/queries.js';
import { loadSlackSettings } from '../services/SlackNotifier.js';

const NOTE_KEY = 'setting:externalApiKey';

/** Get or auto-generate the API key (used by Slack Socket Mode auth) */
export function getOrCreateApiKey(): string {
  const existing = queries.getNote(NOTE_KEY)?.value;
  if (existing) return existing;
  const key = `hurl_${randomBytes(24).toString('hex')}`;
  queries.upsertNote(NOTE_KEY, key, null);
  return key;
}

export function getApiKey(): string {
  return getOrCreateApiKey();
}

export function regenerateApiKey(): string {
  const key = `hurl_${randomBytes(24).toString('hex')}`;
  queries.upsertNote(NOTE_KEY, key, null);
  return key;
}

// ─── Slack thread helper ──────────────────────────────────────────────────

/**
 * Parse a Slack message URL into channel + thread_ts.
 * Formats: https://workspace.slack.com/archives/C123ABC/p1234567890123456
 */
export function parseSlackUrl(url: string): { channel: string; thread_ts: string } | null {
  const match = url.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!match) return null;
  const channel = match[1];
  const raw = match[2];
  const thread_ts = raw.slice(0, 10) + '.' + raw.slice(10);
  return { channel, thread_ts };
}

export async function fetchSlackThread(channel: string, thread_ts: string): Promise<string | null> {
  const { botToken } = loadSlackSettings();
  if (!botToken) return null;

  try {
    const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${thread_ts}&limit=100`, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json();
    if (!data.ok) {
      console.error(`[slack] conversations.replies failed: ${data.error}`);
      return null;
    }
    if (!data.messages?.length) return null;

    return data.messages.map((m: any) => {
      const user = m.user ?? 'unknown';
      const text = m.text ?? '';
      return `[${user}]: ${text}`;
    }).join('\n\n');
  } catch (err) {
    console.error('[slack] failed to fetch thread:', err);
    return null;
  }
}
