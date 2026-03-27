import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { randomUUID } from 'crypto';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';
import { loadSlackSettings } from '../services/SlackNotifier.js';
import { fetchSlackThread } from '../api/external.js';

let client: SocketModeClient | null = null;

export function loadSlackAppToken(): string {
  return queries.getNote('setting:slack:appToken')?.value ?? '';
}

export async function startSlackBot(): Promise<void> {
  const appToken = loadSlackAppToken();
  const { botToken } = loadSlackSettings();

  if (!appToken || !botToken) {
    console.log('[slack-bot] Missing appToken or botToken — skipping Socket Mode');
    return;
  }

  // Tear down existing client if restarting
  await stopSlackBot();

  const socketMode = new SocketModeClient({ appToken });
  const web = new WebClient(botToken);

  // Shared handler: validate user, create job, reply
  async function handleSlackMessage(
    event: any,
    source: 'mention' | 'dm',
  ): Promise<void> {
    const logPrefix = source === 'dm' ? '[slack-bot] DM' : '[slack-bot] app_mention';
    console.log(`${logPrefix} from ${event.user} in ${event.channel}, thread_ts=${event.thread_ts ?? '(none)'}, ts=${event.ts}`);

    // Only accept messages from the configured Slack user
    const { userId: allowedUserId } = loadSlackSettings();
    if (allowedUserId && event.user !== allowedUserId) {
      console.log(`${logPrefix} Ignoring message from ${event.user} (allowed: ${allowedUserId})`);
      return;
    }

    // Strip bot mentions from text (relevant for @mentions, harmless for DMs)
    const description = (event.text as string).replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!description) {
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: 'Please include a task description.',
      });
      return;
    }

    // Fetch thread context if the message is inside an existing thread
    let threadContext = '';
    if (event.thread_ts) {
      try {
        const thread = await fetchSlackThread(event.channel, event.thread_ts);
        if (thread) threadContext = `\n\nSlack thread context:\n${thread}`;
      } catch (err) {
        console.error(`${logPrefix} Failed to fetch thread context:`, err);
      }
    }

    // Resolve repo — use the first repo as default
    const repos = queries.listRepos?.() ?? [];
    const defaultRepo = repos[0] ?? null;

    // Load template setting
    const templateId = queries.getNote('setting:slack:templateId')?.value || null;
    const template = templateId ? queries.getTemplateById(templateId) : null;

    const job = queries.insertJob({
      id: randomUUID(),
      title: description.split('\n')[0].slice(0, 45),
      description: template ? `${template.content}\n\n${description}` : description,
      context: JSON.stringify({
        source: 'slack',
        user: event.user,
        channel: event.channel,
        ...(threadContext ? { thread: threadContext } : {}),
      }),
      priority: 0,
      repo_id: defaultRepo?.id ?? null,
      max_turns: 50,
      model: template?.model ?? null,
      template_id: templateId,
      is_readonly: template?.is_readonly ?? 0,
    });

    socket.emitJobNew(job);

    await web.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Job created: *${job.title}* (\`${job.id}\`)`,
    });

    console.log(`${logPrefix} Created job ${job.id} by ${event.user}`);
  }

  // @slack/socket-mode v2 emits events_api payloads by their inner event type directly
  socketMode.on('app_mention', async ({ ack, event }) => {
    await ack();
    await handleSlackMessage(event, 'mention');
  });

  // Handle direct messages (im channel type)
  socketMode.on('message', async ({ ack, event }) => {
    await ack();
    // Only handle DMs (im), ignore channel messages (handled by app_mention)
    if (event.channel_type !== 'im') return;
    // Ignore bot messages and message subtypes (edits, joins, etc.)
    if (event.bot_id || event.subtype) return;
    await handleSlackMessage(event, 'dm');
  });

  await socketMode.start();
  client = socketMode;
  console.log('[slack-bot] Socket Mode connected, listening for @mentions and DMs');
}

export async function stopSlackBot(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log('[slack-bot] Disconnected');
  }
}
