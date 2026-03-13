import { z } from 'zod';
import * as queries from '../../db/queries.js';

export const writeNoteSchema = z.object({
  key: z.string().describe('Note key (acts as a unique identifier; use namespaced keys like "plan/step1")'),
  value: z.string().describe('Note value (use JSON.stringify for structured data)'),
});

export const readNoteSchema = z.object({
  key: z.string().describe('Note key to read'),
});

export const listNotesSchema = z.object({
  prefix: z.string().optional().describe('Only return keys starting with this prefix (e.g. "plan/")'),
});

export async function writeNoteHandler(agentId: string, input: z.infer<typeof writeNoteSchema>): Promise<string> {
  const { key, value } = input;
  queries.upsertNote(key, value, agentId);
  return JSON.stringify({ ok: true, key });
}

export async function readNoteHandler(_agentId: string, input: z.infer<typeof readNoteSchema>): Promise<string> {
  const { key } = input;
  const note = queries.getNote(key);
  if (!note) {
    return JSON.stringify({ found: false, key, value: null });
  }
  return JSON.stringify({ found: true, key, value: note.value, updated_at: note.updated_at });
}

export async function listNotesHandler(_agentId: string, input: z.infer<typeof listNotesSchema>): Promise<string> {
  const { prefix } = input;
  const notes = queries.listNotes(prefix);
  return JSON.stringify(notes.map(n => ({ key: n.key, updated_at: n.updated_at })));
}
