import * as queries from '../db/queries.js';

interface SlackSettings {
  botToken: string;
  userId: string;
}

export function loadSlackSettings(): SlackSettings {
  return {
    botToken: queries.getNote('setting:slack:botToken')?.value ?? '',
    userId: queries.getNote('setting:slack:userId')?.value ?? '',
  };
}

async function sendSlackDM(token: string, userId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: userId, text }),
  });
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

export async function notifyFailure(title: string, errorMessage: string, context?: string): Promise<void> {
  const { botToken, userId } = loadSlackSettings();
  if (!botToken || !userId) return;

  const lines = [`*Failed:* ${title}`];
  if (errorMessage) lines.push(`> ${errorMessage}`);
  if (context) lines.push(context);

  try {
    await sendSlackDM(botToken, userId, lines.join('\n'));
  } catch (err) {
    console.error('[slack] Failed to send notification:', err);
  }
}

export async function notifyMerge(branch: string, jobTitle?: string | null): Promise<void> {
  const { botToken, userId } = loadSlackSettings();
  if (!botToken || !userId) return;

  const lines = [`*PR merged:* \`${branch}\``];
  if (jobTitle) lines.push(`Job: ${jobTitle}`);

  try {
    await sendSlackDM(botToken, userId, lines.join('\n'));
  } catch (err) {
    console.error('[slack] Failed to send merge notification:', err);
  }
}

export async function sendTestMessage(token: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  return sendSlackDM(token, userId, 'Test notification from Hurlicane — Slack integration is working.');
}
