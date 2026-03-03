import { Router } from 'express';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';
import * as queries from '../db/queries.js';

const router = Router();

/**
 * Extract "owner/repo" from a git remote URL.
 * Handles HTTPS (https://github.com/owner/repo.git) and SSH (git@github.com:owner/repo.git).
 */
function parseGitHubName(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/[:\/]([^/]+\/[^/]+?)(?:\.git)?\s*$/);
  if (sshMatch) return sshMatch[1];
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\s*$/);
  if (httpsMatch) return httpsMatch[1];
  return null;
}

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
  if (!path?.trim()) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const repoPath = path.trim();

  // Validate that path is a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    res.status(400).json({ error: 'Path is not a git repository' });
    return;
  }

  // Auto-derive owner/repo from git remote, fall back to provided name
  let repoName = name?.trim() || '';
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: repoPath, stdio: 'pipe' }).toString().trim();
    const parsed = parseGitHubName(remoteUrl);
    if (parsed) repoName = parsed;
  } catch { /* no origin remote */ }

  if (!repoName) {
    res.status(400).json({ error: 'Could not detect repo name from git remote. Provide a name manually.' });
    return;
  }

  const repo = queries.insertRepo({ id: randomUUID(), name: repoName, path: repoPath });
  res.status(201).json(repo);
});

router.delete('/:id', (req, res) => {
  queries.deleteRepo(req.params.id);
  res.json({ ok: true });
});

export default router;
