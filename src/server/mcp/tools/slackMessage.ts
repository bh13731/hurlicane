import { z } from 'zod';
import { loadSlackSettings } from '../../services/SlackNotifier.js';

const blockSchema = z.object({
  type: z.string().describe('Block type, e.g. "section", "header", "divider", "context"'),
  text: z.object({
    type: z.string().describe('"mrkdwn" or "plain_text"'),
    text: z.string(),
    emoji: z.boolean().optional(),
  }).optional(),
  fields: z.array(z.object({
    type: z.string(),
    text: z.string(),
  })).optional(),
  elements: z.array(z.object({
    type: z.string(),
    text: z.string(),
  })).optional(),
});

export const slackMessageSchema = z.object({
  headline: z.string().describe('Short summary shown in notifications and as fallback text (one line, no formatting)'),
  blocks: z.array(blockSchema).describe('Slack Block Kit blocks for the message body. Use sections, headers, dividers, context blocks, mrkdwn fields, etc. to create a well-formatted message.'),
});

export async function slackMessageHandler(agentId: string, input: z.infer<typeof slackMessageSchema>): Promise<string> {
  const { botToken, userId } = loadSlackSettings();
  if (!botToken || !userId) {
    return 'Slack is not configured — set bot token and user ID in the Slack panel.';
  }

  const { headline, blocks } = input;

  // Prepend a context block with the agent ID
  const fullBlocks = [
    ...blocks,
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Agent: \`${agentId}\`` }] },
  ];

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: userId,
      text: `[${agentId}] ${headline}`,
      blocks: fullBlocks,
    }),
  });

  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) return `Slack error: ${data.error}`;
  return 'Message sent.';
}
