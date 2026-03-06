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

async function sendSlackDM(
  token: string,
  userId: string,
  text: string,
  blocks?: unknown[],
): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = { channel: userId, text };
  if (blocks) payload.blocks = blocks;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

async function notify(text: string, blocks?: unknown[]): Promise<void> {
  const { botToken, userId } = loadSlackSettings();
  if (!botToken || !userId) return;
  try {
    await sendSlackDM(botToken, userId, text, blocks);
  } catch (err) {
    console.error('[slack] Failed to send notification:', err);
  }
}

export async function notifyFailure(title: string, errorMessage: string, context?: string): Promise<void> {
  const fallback = `Failed: ${title}${errorMessage ? ` — ${errorMessage}` : ''}`;
  const fields: { type: string; text: string }[] = [];
  if (context) fields.push({ type: 'mrkdwn', text: `*Context:*\n${context}` });

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':red_circle: Agent Failed', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${title}*` },
    },
  ];
  if (errorMessage) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${errorMessage}\`\`\`` },
    });
  }
  if (fields.length > 0) {
    blocks.push({ type: 'section', fields });
  }

  await notify(fallback, blocks);
}

export async function notifyAllChecksPassed(repo: string, pr: number, branch: string, sha: string): Promise<void> {
  const fallback = `All checks passed: ${repo}#${pr} (${branch})`;
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':white_check_mark: All Checks Passed', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Repo:*\n${repo}` },
        { type: 'mrkdwn', text: `*PR:*\n#${pr}` },
        { type: 'mrkdwn', text: `*Branch:*\n\`${branch}\`` },
        { type: 'mrkdwn', text: `*Commit:*\n\`${sha}\`` },
      ],
    },
  ];
  await notify(fallback, blocks);
}

export async function sendTestMessage(token: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  return sendSlackDM(token, userId, 'Test notification from Hurlicane', [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':white_check_mark: Slack Connected', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'Slack integration is working. You\'ll receive notifications for agent failures, worktree creation, and cleanup.' },
    },
  ]);
}
