import { z } from 'zod';
import * as queries from '../../db/queries.js';
import * as socket from '../../socket/SocketManager.js';

export const watchNotesSchema = z.object({
  keys: z.array(z.string()).optional().describe('Note keys that must all exist'),
  prefix: z.string().optional().describe('At least one note under this prefix must exist'),
  until_value: z.string().optional().describe('If set, matched notes must have this exact value'),
  timeout_ms: z.number().optional().describe('Max wait time in ms (default: 300000 = 5 min)'),
});

const POLL_MS = 2000;

export async function watchNotesHandler(agentId: string, input: z.infer<typeof watchNotesSchema>): Promise<string> {
  const { keys, prefix, until_value, timeout_ms = 300000 } = input;

  if (!keys && !prefix) {
    return JSON.stringify({ error: 'Provide either keys or prefix' });
  }

  const deadline = Date.now() + timeout_ms;

  const updateStatus = (msg: string) => {
    queries.updateAgent(agentId, { status_message: msg });
    const agentWithJob = queries.getAgentWithJob(agentId);
    if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
  };

  const label = keys ? `keys [${keys.join(', ')}]` : `prefix "${prefix}"`;
  updateStatus(`Watching notes: ${label}…`);

  while (Date.now() < deadline) {
    const matched = checkNotes(keys, prefix, until_value);
    if (matched) {
      queries.updateAgent(agentId, { status_message: null });
      const agentWithJob = queries.getAgentWithJob(agentId);
      if (agentWithJob) socket.emitAgentUpdate(agentWithJob);
      return JSON.stringify({ matched });
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  // Timed out
  queries.updateAgent(agentId, { status_message: null });
  const agentWithJob = queries.getAgentWithJob(agentId);
  if (agentWithJob) socket.emitAgentUpdate(agentWithJob);

  return JSON.stringify({ error: `Timed out after ${timeout_ms}ms`, matched: null });
}

function checkNotes(
  keys: string[] | undefined,
  prefix: string | undefined,
  untilValue: string | undefined,
): Array<{ key: string; value: string; updated_at: number }> | null {
  if (keys) {
    const results: Array<{ key: string; value: string; updated_at: number }> = [];
    for (const key of keys) {
      const note = queries.getNote(key);
      if (!note) return null;
      if (untilValue !== undefined && note.value !== untilValue) return null;
      results.push({ key: note.key, value: note.value, updated_at: note.updated_at });
    }
    return results;
  }

  if (prefix) {
    const notes = queries.listNotes(prefix);
    if (notes.length === 0) return null;
    const matching = untilValue !== undefined
      ? notes.filter(n => n.value === untilValue)
      : notes;
    if (matching.length === 0) return null;
    return matching.map(n => ({ key: n.key, value: n.value, updated_at: n.updated_at }));
  }

  return null;
}
