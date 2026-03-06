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
    console.log(`[slack-bot] app_mention from ${event.user} in ${event.channel}`);

    const description = (event.text as string).replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!description) {
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: 'Please include a task description after the mention.',
      });
      return;
    }

    // Fetch thread context if the mention is in a thread
    const threadTs = event.thread_ts ?? event.ts;
    let threadContext = '';
    try {
      const thread = await fetchSlackThread(event.channel, threadTs);
      if (thread) threadContext = `\n\nSlack thread context:\n${thread}`;
    } catch (err) {
      console.error('[slack-bot] Failed to fetch thread context:', err);
    }

    // Resolve work_dir — use the first repo's path, or cwd as fallback
    const repos = queries.listRepos?.() ?? [];
    const defaultWorkDir = repos[0]?.path ?? process.cwd();

    const job = queries.insertJob({
      id: randomUUID(),
      title: description.split('\n')[0].slice(0, 45),
      description,
      context: `Created from Slack by <@${event.user}> in <#${event.channel}>${threadContext}`,
      priority: 0,
      work_dir: defaultWorkDir,
      max_turns: 50,
      use_worktree: 1,
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
