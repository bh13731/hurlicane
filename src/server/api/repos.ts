import { Router } from 'express';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as queries from '../db/queries.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(queries.listRepos());
});

// Wildcard captures the slash in "owner/repo"
router.get('/by-name/:name(*)', (req, res) => {
  const repo = queries.getRepoByName(req.params.name);
  if (!repo) { res.status(404).json({ error: 'repo not found' }); return; }
  res.json(repo);
});

router.post('/', (req, res) => {
  const { name, path } = req.body as { name?: string; path?: string };
  if (!name?.trim() || !path?.trim()) {
    res.status(400).json({ error: 'name and path are required' });
    return;
  }
  // Validate that path is a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: path.trim(), stdio: 'pipe' });
  } catch {
    res.status(400).json({ error: 'Path is not a git repository' });
    return;
  }
  const repo = queries.insertRepo({ id: randomUUID(), name: name.trim(), path: path.trim() });
  res.status(201).json(repo);
});

router.delete('/:id', (req, res) => {
  queries.deleteRepo(req.params.id);
  res.json({ ok: true });
});

export default router;
