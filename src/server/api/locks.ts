import { Router } from 'express';
import * as queries from '../db/queries.js';
import * as socket from '../socket/SocketManager.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.getAllActiveLocks());
});

// Check if a specific agent holds a lock for a file (used by the PreToolUse hook)
router.get('/check', (req, res) => {
  const { agent_id, file } = req.query as { agent_id?: string; file?: string };
  if (!agent_id || !file) {
    res.status(400).json({ error: 'agent_id and file required' });
    return;
  }
  const activeLocks = queries.getActiveLocksForFile(file);
  const locked = activeLocks.some(l => l.agent_id === agent_id);
  res.json({ locked });
});

router.delete('/:id', (req, res) => {
  const lock = queries.getFileLockById(req.params.id);
  if (!lock) { res.status(404).json({ error: 'not found' }); return; }
  queries.releaseLock(lock.id);
  socket.emitLockReleased(lock.id, lock.file_path);
  res.json({ ok: true });
});

export default router;
