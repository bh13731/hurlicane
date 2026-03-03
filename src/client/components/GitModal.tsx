import React, { useState, useEffect } from 'react';

interface Worktree {
  id: string;
  agent_id: string;
  job_id: string;
  path: string;
  branch: string;
  created_at: number;
  cleaned_at: number | null;
}

interface Repo {
  id: string;
  name: string;
  path: string;
  created_at: number;
}

interface GitModalProps {
  onClose: () => void;
}

export function GitModal({ onClose }: GitModalProps) {
  const [worktreeStats, setWorktreeStats] = useState<{ active: number; cleaned: number } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [newBranch, setNewBranch] = useState('');
  const [newRepoId, setNewRepoId] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Repos state
  const [repos, setRepos] = useState<Repo[]>([]);
  const [newRepoPath, setNewRepoPath] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);

  const fetchRepos = () => {
    fetch('/api/repos')
      .then(r => r.json())
      .then(setRepos)
      .catch(() => {});
  };

  const fetchWorktrees = () => {
    fetch('/api/worktrees')
      .then(r => r.json())
      .then(setWorktrees)
      .catch(() => {});
    fetch('/api/worktrees/stats')
      .then(r => r.json())
      .then(setWorktreeStats)
      .catch(() => {});
  };

  useEffect(() => {
    fetchRepos();
    fetchWorktrees();
  }, []);

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      await fetch('/api/worktrees/cleanup', { method: 'POST' });
      fetchWorktrees();
    } finally {
      setCleaning(false);
    }
  };

  const handleCreate = async () => {
    if (!newBranch.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const selectedRepo = repos.find(r => r.id === newRepoId);
      const res = await fetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: newBranch.trim(), repoDir: selectedRepo?.path || undefined }),
      });
      if (res.ok) {
        setNewBranch('');
        fetchWorktrees();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to create worktree');
      }
    } catch {
      setError('Failed to create worktree');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/worktrees/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchWorktrees();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete worktree');
      }
    } catch {
      setError('Failed to delete worktree');
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddRepo = async () => {
    if (!newRepoPath.trim()) return;
    setAddingRepo(true);
    setRepoError(null);
    try {
      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newRepoPath.trim() }),
      });
      if (res.ok) {
        setNewRepoPath('');
        fetchRepos();
      } else {
        const data = await res.json();
        setRepoError(data.error || 'Failed to add repo');
      }
    } catch {
      setRepoError('Failed to add repo');
    } finally {
      setAddingRepo(false);
    }
  };

  const handleDeleteRepo = async (id: string) => {
    setDeletingRepoId(id);
    setRepoError(null);
    try {
      const res = await fetch(`/api/repos/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchRepos();
      } else {
        const data = await res.json();
        setRepoError(data.error || 'Failed to delete repo');
      }
    } catch {
      setRepoError('Failed to delete repo');
    } finally {
      setDeletingRepoId(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Git</h2>
          <button className="btn-icon" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          {/* Repos section */}
          <div className="form-group">
            <label>Repos</label>

            {repos.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {repos.map(repo => (
                  <div key={repo.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 0',
                    fontSize: 13,
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500 }}>{repo.name}</span>
                      <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 12 }}>
                        {repo.path}
                      </span>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ marginLeft: 8, flexShrink: 0 }}
                      onClick={() => handleDeleteRepo(repo.id)}
                      disabled={deletingRepoId === repo.id}
                    >
                      {deletingRepoId === repo.id ? '...' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Path (e.g. /home/user/myrepo)"
                value={newRepoPath}
                onChange={e => setNewRepoPath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddRepo()}
                style={{ flex: 2, minWidth: 160 }}
              />
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleAddRepo}
                disabled={addingRepo || !newRepoPath.trim()}
              >
                {addingRepo ? 'Adding...' : 'Add'}
              </button>
            </div>

            {repoError && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{repoError}</div>
            )}
          </div>

          {/* Worktrees section */}
          <div className="form-group" style={{ marginTop: 16 }}>
            <label>Worktrees</label>
            {worktreeStats && (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Active: {worktreeStats.active} | Cleaned: {worktreeStats.cleaned}
              </div>
            )}

            {worktrees.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {worktrees.map(wt => (
                  <div key={wt.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 0',
                    fontSize: 13,
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500 }}>{wt.branch}</span>
                      <span style={{ color: 'var(--text-secondary)', marginLeft: 8, fontSize: 12 }}>
                        {wt.path}
                      </span>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ marginLeft: 8, flexShrink: 0 }}
                      onClick={() => handleDelete(wt.id)}
                      disabled={deletingId === wt.id}
                    >
                      {deletingId === wt.id ? '...' : 'Delete'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Branch name"
                value={newBranch}
                onChange={e => setNewBranch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                style={{ flex: 1, minWidth: 120 }}
              />
              <select
                value={newRepoId}
                onChange={e => setNewRepoId(e.target.value)}
                style={{ flex: 1, minWidth: 120 }}
              >
                <option value="" disabled>Select a repo</option>
                {repos.map(repo => (
                  <option key={repo.id} value={repo.id}>{repo.name}</option>
                ))}
              </select>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCreate}
                disabled={creating || !newBranch.trim()}
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>

            {error && (
              <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{error}</div>
            )}

            {worktreeStats && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleCleanup}
                disabled={cleaning || worktreeStats.active === 0}
                style={{ marginTop: 8 }}
              >
                {cleaning ? 'Cleaning...' : 'Clean up now'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
