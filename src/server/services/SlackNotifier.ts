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

async function notify(text: string): Promise<void> {
  const { botToken, userId } = loadSlackSettings();
  if (!botToken || !userId) return;
  try {
    await sendSlackDM(botToken, userId, text);
  } catch (err) {
    console.error('[slack] Failed to send notification:', err);
  }
}

export async function notifyFailure(title: string, errorMessage: string, context?: string): Promise<void> {
  const lines = [`*Failed:* ${title}`];
  if (errorMessage) lines.push(`> ${errorMessage}`);
  if (context) lines.push(context);
  await notify(lines.join('\n'));
}

export async function notifyWorktreeCreated(branch: string, jobTitle?: string | null): Promise<void> {
  const lines = [`*Worktree created:* \`${branch}\``];
  if (jobTitle) lines.push(`Job: ${jobTitle}`);
  await notify(lines.join('\n'));
}

export async function notifyWorktreeCleaned(branch: string, jobTitle?: string | null): Promise<void> {
  const lines = [`*Worktree cleaned:* \`${branch}\``];
  if (jobTitle) lines.push(`Job: ${jobTitle}`);
  await notify(lines.join('\n'));
}

export async function sendTestMessage(token: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  return sendSlackDM(token, userId, 'Test notification from Hurlicane — Slack integration is working.');
}
