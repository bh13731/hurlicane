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

  // @slack/socket-mode v2 emits events_api payloads by their inner event type directly
  socketMode.on('app_mention', async ({ ack, event, body }) => {
    await ack();
    console.log(`[slack-bot] app_mention from ${event.user} in ${event.channel}, thread_ts=${event.thread_ts ?? '(none)'}, ts=${event.ts}`);

    const description = (event.text as string).replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!description) {
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: 'Please include a task description after the mention.',
      });
      return;
    }

    // Fetch thread context if the mention is inside an existing thread
    let threadContext = '';
    if (event.thread_ts) {
      try {
        const thread = await fetchSlackThread(event.channel, event.thread_ts);
        if (thread) threadContext = `\n\nSlack thread context:\n${thread}`;
      } catch (err) {
        console.error('[slack-bot] Failed to fetch thread context:', err);
      }
    }

    // Resolve work_dir — use the first repo's path, or cwd as fallback
    const repos = queries.listRepos?.() ?? [];
    const defaultWorkDir = repos[0]?.path ?? process.cwd();

    // Load template setting
    const templateId = queries.getNote('setting:slack:templateId')?.value || null;
    const template = templateId ? queries.getTemplateById(templateId) : null;

    const job = queries.insertJob({
      id: randomUUID(),
      title: description.split('\n')[0].slice(0, 45),
      description: template ? `${template.content}\n\n${description}` : description,
      context: `Created from Slack by <@${event.user}> in <#${event.channel}>${threadContext}`,
      priority: 0,
      work_dir: defaultWorkDir,
      max_turns: 50,
      model: template?.model ?? null,
      template_id: templateId,
      is_readonly: template?.is_readonly ?? 0,
      use_worktree: template?.is_readonly ? 0 : 1,
    });

    socket.emitJobNew(job);

    await web.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Job created: *${job.title}* (\`${job.id}\`)`,
    });

    console.log(`[slack-bot] Created job ${job.id} from @mention by ${event.user}`);
  });

  await socketMode.start();
  client = socketMode;
  console.log('[slack-bot] Socket Mode connected, listening for @mentions');
}

export async function stopSlackBot(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
    console.log('[slack-bot] Disconnected');
  }
}
