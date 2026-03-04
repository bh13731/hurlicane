import React, { useState, useEffect, useRef } from 'react';
import socket from '../socket';

interface Worktree {
  id: string;
  repo_id: string;
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
  url: string;
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
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);

  // Clone progress
  const [clonePhase, setClonePhase] = useState('');
  const [clonePercent, setClonePercent] = useState<number | null>(null);
  const cloneRepoIdRef = useRef<string | null>(null);

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

    const handleProgress = (payload: { repo_id: string; phase: string; percent: number | null }) => {
      if (cloneRepoIdRef.current && payload.repo_id === cloneRepoIdRef.current) {
        setClonePhase(payload.phase);
        setClonePercent(payload.percent);
      }
    };
    socket.on('repo:clone-progress', handleProgress);
    return () => { socket.off('repo:clone-progress', handleProgress); };
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
    if (!newBranch.trim() || !newRepoId) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: newBranch.trim(), repoId: newRepoId }),
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
    if (!newRepoUrl.trim()) return;
    setAddingRepo(true);
    setRepoError(null);
    setClonePhase('Starting clone...');
    setClonePercent(null);

    // Generate a predictable ID so we can match socket events.
    // The server generates the real ID, but we listen for any clone progress.
    // We'll track whatever clone is in flight.
    cloneRepoIdRef.current = null;

    try {
      // We need to know the repo ID before the response arrives so we can
      // match socket events. Listen for ANY clone-progress event while we're
      // the one cloning (only one clone at a time from this modal).
      const catchAll = (payload: { repo_id: string; phase: string; percent: number | null }) => {
        cloneRepoIdRef.current = payload.repo_id;
        setClonePhase(payload.phase);
        setClonePercent(payload.percent);
      };
      socket.on('repo:clone-progress', catchAll);

      const res = await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newRepoUrl.trim() }),
      });

      socket.off('repo:clone-progress', catchAll);

      if (res.ok) {
        setNewRepoUrl('');
        fetchRepos();
      } else {
        const data = await res.json();
        setRepoError(data.error || 'Failed to add repo');
      }
    } catch {
      setRepoError('Failed to add repo');
    } finally {
      setAddingRepo(false);
      cloneRepoIdRef.current = null;
      setClonePhase('');
      setClonePercent(null);
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
                        {repo.url}
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
                placeholder="Clone URL (e.g. git@github.com:owner/repo.git)"
                value={newRepoUrl}
                onChange={e => setNewRepoUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddRepo()}
                style={{ flex: 2, minWidth: 160 }}
                disabled={addingRepo}
              />
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleAddRepo}
                disabled={addingRepo || !newRepoUrl.trim()}
              >
                {addingRepo ? 'Cloning...' : 'Add'}
              </button>
            </div>

            {addingRepo && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 3 }}>
                  {clonePhase || 'Connecting...'}
                  {clonePercent != null && ` ${clonePercent}%`}
                </div>
                <div style={{
                  height: 4,
                  borderRadius: 2,
                  background: 'var(--border)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    borderRadius: 2,
                    background: 'var(--accent, #4f8ff7)',
                    width: clonePercent != null ? `${clonePercent}%` : '100%',
                    transition: clonePercent != null ? 'width 0.3s ease' : 'none',
                    animation: clonePercent == null ? 'clone-indeterminate 1.5s ease-in-out infinite' : 'none',
                  }} />
                </div>
                <style>{`
                  @keyframes clone-indeterminate {
                    0% { width: 0%; margin-left: 0%; }
                    50% { width: 40%; margin-left: 30%; }
                    100% { width: 0%; margin-left: 100%; }
                  }
                `}</style>
              </div>
            )}

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
                disabled={creating || !newBranch.trim() || !newRepoId}
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
