import { Router } from 'express';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import * as queries from '../db/queries.js';
import { emitRepoCloneProgress } from '../socket/SocketManager.js';

const router = Router();

/** Directory where cloned repos are stored. */
const REPOS_DIR = path.resolve('data', 'repos');

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

/**
 * Parse git clone --progress stderr output for phase and percentage.
 * Lines look like: "Receiving objects:  45% (556/1234), 12.34 MiB | 5.67 MiB/s"
 */
function parseGitProgress(line: string): { phase: string; percent: number | null } | null {
  // Match lines like "Receiving objects:  45% (556/1234)"
  const match = line.match(/^([\w\s]+):\s+(\d+)%/);
  if (match) return { phase: match[1].trim(), percent: parseInt(match[2], 10) };
  // Match phase-only lines like "Cloning into bare repository..."
  const phaseOnly = line.match(/^(Cloning into|Updating files)/);
  if (phaseOnly) return { phase: line.trim(), percent: null };
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
  const { name, url } = req.body as { name?: string; url?: string };
  if (!url?.trim()) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
  const repoUrl = url.trim();

  // Auto-derive owner/repo from the URL, fall back to provided name
  let repoName = name?.trim() || '';
  const parsed = parseGitHubName(repoUrl);
  if (parsed) repoName = parsed;

  if (!repoName) {
    res.status(400).json({ error: 'Could not detect repo name from URL. Provide a name manually.' });
    return;
  }

  const id = randomUUID();
  const repoPath = path.join(REPOS_DIR, id);

  fs.mkdirSync(REPOS_DIR, { recursive: true });

  const child = spawn('git', ['clone', '--progress', repoUrl, repoPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 120_000,
  });

  // Git writes progress to stderr; it uses \r for in-place updates
  let stderr = '';
  let stderrBuf = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    stderrBuf += chunk.toString();
    // Split on \r or \n to get individual progress lines
    const parts = stderrBuf.split(/[\r\n]+/);
    stderrBuf = parts.pop() || '';
    for (const part of parts) {
      const progress = parseGitProgress(part);
      if (progress) {
        emitRepoCloneProgress(id, progress.phase, progress.percent);
      }
    }
  });

  child.on('close', (code) => {
    // Flush remaining buffer
    if (stderrBuf.trim()) {
      const progress = parseGitProgress(stderrBuf.trim());
      if (progress) emitRepoCloneProgress(id, progress.phase, progress.percent);
    }

    if (code !== 0) {
      try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
      emitRepoCloneProgress(id, 'Failed', null);
      res.status(400).json({ error: `Clone failed (exit ${code}): ${stderr.trim()}` });
      return;
    }
    emitRepoCloneProgress(id, 'Done', 100);
    const repo = queries.insertRepo({ id, name: repoName, url: repoUrl, path: repoPath });
    res.status(201).json(repo);
  });

  child.on('error', (err) => {
    try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
    emitRepoCloneProgress(id, 'Failed', null);
    res.status(500).json({ error: `Clone failed: ${err.message}` });
  });
});

router.get('/:id/branches', (req, res) => {
  const repo = queries.getRepoById(req.params.id);
  if (!repo) { res.status(404).json({ error: 'repo not found' }); return; }

  const fetch = spawn('git', ['fetch', 'origin', '--prune'], { cwd: repo.path, stdio: 'ignore' });
  fetch.on('close', (fetchCode) => {
    if (fetchCode !== 0) {
      res.status(500).json({ error: 'git fetch failed' });
      return;
    }
    const branchProc = spawn('git', ['branch', '-r', '--format=%(refname:short)'], {
      cwd: repo.path,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    branchProc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    branchProc.on('close', (code) => {
      if (code !== 0) {
        res.status(500).json({ error: 'git branch -r failed' });
        return;
      }
      const branches = stdout
        .split('\n')
        .map(b => b.trim())
        .filter(b => b && !b.endsWith('/HEAD'))
        .map(b => b.replace(/^origin\//, ''));
      res.json(branches);
    });
  });
  fetch.on('error', (err) => {
    res.status(500).json({ error: `git fetch error: ${err.message}` });
  });
});

router.patch('/:id', (req, res) => {
  const { default_branch } = req.body as { default_branch?: string };
  if (!default_branch || typeof default_branch !== 'string' || !default_branch.trim()) {
    res.status(400).json({ error: 'default_branch is required' });
    return;
  }
  const repo = queries.updateRepo(req.params.id, { default_branch: default_branch.trim() });
  if (!repo) { res.status(404).json({ error: 'repo not found' }); return; }
  res.json(repo);
});

router.delete('/:id', (req, res) => {
  const repo = queries.getRepoById(req.params.id);
  if (repo) {
    // Remove the bare clone from disk
    try { fs.rmSync(repo.path, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  queries.deleteRepo(req.params.id);
  res.json({ ok: true });
});

export default router;
