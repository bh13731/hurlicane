import React, { useState, useEffect, useCallback } from 'react';
import type { Worktree, Repo } from '@shared/types';

interface WorktreesSidebarProps {
  selectedWorktreeId?: string;
  onSelectWorktree: (wt: Worktree) => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function WorktreesSidebar({ selectedWorktreeId, onSelectWorktree }: WorktreesSidebarProps) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const [reposRes, wtRes] = await Promise.all([
        fetch('/api/repos'),
        fetch('/api/worktrees'),
      ]);
      if (reposRes.ok) setRepos(await reposRes.json());
      if (wtRes.ok) setWorktrees(await wtRes.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 10_000);
    return () => clearInterval(id);
  }, [fetchData]);

  const toggleRepo = (repoId: string) => {
    setCollapsedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  // Group worktrees by repo: worktree path is <repoDir>/../.orchestrator-worktrees/<id>
  // So resolve(wt.path, '..', '..') gives the repo dir
  const grouped = new Map<string, { repo: Repo; worktrees: Worktree[] }>();
  const ungrouped: Worktree[] = [];

  for (const wt of worktrees) {
    // Extract repo dir: /path/to/repo/../.orchestrator-worktrees/abc -> /path/to/repo (2 levels up)
    const parts = wt.path.split('/');
    // Remove last 2 segments (.orchestrator-worktrees/<id>)
    const repoDir = parts.slice(0, -2).join('/');
    const repo = repos.find(r => r.path === repoDir);
    if (repo) {
      if (!grouped.has(repo.id)) grouped.set(repo.id, { repo, worktrees: [] });
      grouped.get(repo.id)!.worktrees.push(wt);
    } else {
      ungrouped.push(wt);
    }
  }

  return (
    <div className="sidebar worktrees-sidebar">
      <div className="sidebar-title">Worktrees</div>
      {worktrees.length === 0 && (
        <div className="worktrees-empty">No active worktrees</div>
      )}
      {Array.from(grouped.values()).map(({ repo, worktrees: wts }) => (
        <div key={repo.id} className="worktree-repo-group">
          <div
            className="sidebar-section-label worktree-repo-header"
            onClick={() => toggleRepo(repo.id)}
          >
            <span className="worktree-repo-chevron">{collapsedRepos.has(repo.id) ? '\u25B6' : '\u25BC'}</span>
            <span className="worktree-repo-name">{repo.name}</span>
            <span className="worktree-repo-count">{wts.length}</span>
          </div>
          {!collapsedRepos.has(repo.id) && wts.map(wt => (
            <div
              key={wt.id}
              className={`worktree-item ${selectedWorktreeId === wt.id ? 'worktree-item--selected' : ''}`}
              onClick={() => onSelectWorktree(wt)}
            >
              <span className="worktree-item-branch">{wt.branch}</span>
              <span className="worktree-item-time">{timeAgo(wt.created_at)}</span>
            </div>
          ))}
        </div>
      ))}
      {ungrouped.length > 0 && (
        <div className="worktree-repo-group">
          <div className="sidebar-section-label">Other</div>
          {ungrouped.map(wt => (
            <div
              key={wt.id}
              className={`worktree-item ${selectedWorktreeId === wt.id ? 'worktree-item--selected' : ''}`}
              onClick={() => onSelectWorktree(wt)}
            >
              <span className="worktree-item-branch">{wt.branch}</span>
              <span className="worktree-item-time">{timeAgo(wt.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
