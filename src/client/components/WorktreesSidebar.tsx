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
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [editingBranch, setEditingBranch] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState('');

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

  // Group worktrees by repo_id
  const grouped = new Map<string, { repo: Repo; worktrees: Worktree[] }>();
  const ungrouped: Worktree[] = [];

  for (const wt of worktrees) {
    const repo = repos.find(r => r.id === wt.repo_id);
    if (repo) {
      if (!grouped.has(repo.id)) grouped.set(repo.id, { repo, worktrees: [] });
      grouped.get(repo.id)!.worktrees.push(wt);
    } else {
      ungrouped.push(wt);
    }
  }

  const handleSaveBranch = async (repoId: string) => {
    const trimmed = branchInput.trim();
    if (!trimmed) return;
    try {
      const res = await fetch(`/api/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_branch: trimmed }),
      });
      if (res.ok) {
        const updated = await res.json();
        setRepos(prev => prev.map(r => r.id === repoId ? updated : r));
      }
    } catch { /* ignore */ }
    setEditingBranch(null);
  };

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanResult(null);
    try {
      const res = await fetch('/api/worktrees/cleanup', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setCleanResult(`Cleaned ${data.cleaned} worktree${data.cleaned === 1 ? '' : 's'}`);
        fetchData();
      }
    } catch { /* ignore */ }
    finally { setCleaning(false); }
  };

  return (
    <div className="sidebar worktrees-sidebar">
      <div className="sidebar-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Worktrees
        <button
          className="btn btn-sm btn-secondary"
          onClick={handleCleanup}
          disabled={cleaning || worktrees.length === 0}
          title="Remove worktrees whose PR was merged/closed or branch deleted"
          style={{ fontSize: 11, padding: '2px 8px' }}
        >
          {cleaning ? 'Cleaning...' : 'Clean Up'}
        </button>
      </div>
      {cleanResult && (
        <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-secondary)' }}>{cleanResult}</div>
      )}
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
          {!collapsedRepos.has(repo.id) && (
            <div className="worktree-repo-base-branch">
              {editingBranch === repo.id ? (
                <form className="worktree-base-branch-form" onSubmit={e => { e.preventDefault(); handleSaveBranch(repo.id); }}>
                  <input
                    type="text"
                    value={branchInput}
                    onChange={e => setBranchInput(e.target.value)}
                    autoFocus
                    onBlur={() => setEditingBranch(null)}
                    onKeyDown={e => e.key === 'Escape' && setEditingBranch(null)}
                    className="worktree-base-branch-input"
                  />
                </form>
              ) : (
                <span
                  className="worktree-base-branch-label"
                  onClick={e => { e.stopPropagation(); setEditingBranch(repo.id); setBranchInput(repo.default_branch || 'main'); }}
                  title="Click to change base branch"
                >
                  base: {repo.default_branch || 'main'}
                </span>
              )}
            </div>
          )}
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
