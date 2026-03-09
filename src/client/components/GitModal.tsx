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
  default_branch: string;
  instructions: string;
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

  // Base branch editing
  const [editingBranchRepoId, setEditingBranchRepoId] = useState<string | null>(null);
  const [branchInput, setBranchInput] = useState('');

  // Repo instructions editing
  const [editingInstructionsRepoId, setEditingInstructionsRepoId] = useState<string | null>(null);
  const [instructionsInput, setInstructionsInput] = useState('');
  const [savingInstructions, setSavingInstructions] = useState(false);

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

  const handleSaveBranch = async (repoId: string) => {
    const trimmed = branchInput.trim();
    if (!trimmed) { setEditingBranchRepoId(null); return; }
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
    setEditingBranchRepoId(null);
  };

  const handleSaveInstructions = async (repoId: string) => {
    setSavingInstructions(true);
    try {
      const res = await fetch(`/api/repos/${repoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: instructionsInput }),
      });
      if (res.ok) {
        const updated = await res.json();
        setRepos(prev => prev.map(r => r.id === repoId ? updated : r));
      }
    } catch { /* ignore */ }
    setSavingInstructions(false);
    setEditingInstructionsRepoId(null);
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
                    padding: '6px 0',
                    fontSize: 13,
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
                    <div style={{ marginTop: 3, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>base:</span>
                      {editingBranchRepoId === repo.id ? (
                        <form onSubmit={e => { e.preventDefault(); handleSaveBranch(repo.id); }} style={{ display: 'inline-flex' }}>
                          <input
                            type="text"
                            value={branchInput}
                            onChange={e => setBranchInput(e.target.value)}
                            autoFocus
                            onBlur={() => handleSaveBranch(repo.id)}
                            onKeyDown={e => e.key === 'Escape' && setEditingBranchRepoId(null)}
                            style={{
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              background: 'var(--bg-primary)',
                              border: '1px solid var(--accent-muted)',
                              borderRadius: 4,
                              color: 'var(--text-primary)',
                              padding: '1px 6px',
                              width: 120,
                            }}
                          />
                        </form>
                      ) : (
                        <span
                          style={{
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            padding: '0 4px',
                            borderRadius: 3,
                          }}
                          onClick={() => { setEditingBranchRepoId(repo.id); setBranchInput(repo.default_branch || 'main'); }}
                          title="Click to change base branch"
                        >
                          {repo.default_branch || 'main'}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ color: 'var(--text-muted)' }}>instructions:</span>
                      {editingInstructionsRepoId === repo.id ? (
                        <div style={{ flex: 1 }}>
                          <textarea
                            value={instructionsInput}
                            onChange={e => setInstructionsInput(e.target.value)}
                            autoFocus
                            rows={4}
                            placeholder="Additional instructions appended to agent prompts for this repo..."
                            style={{
                              width: '100%',
                              fontSize: 11,
                              fontFamily: 'var(--font-mono)',
                              background: 'var(--bg-primary)',
                              border: '1px solid var(--accent-muted)',
                              borderRadius: 4,
                              color: 'var(--text-primary)',
                              padding: '4px 6px',
                              resize: 'vertical',
                            }}
                          />
                          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleSaveInstructions(repo.id)}
                              disabled={savingInstructions}
                              style={{ fontSize: 10 }}
                            >
                              {savingInstructions ? '...' : 'Save'}
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => setEditingInstructionsRepoId(null)}
                              style={{ fontSize: 10 }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span
                          style={{
                            color: repo.instructions ? 'var(--text-secondary)' : 'var(--text-muted)',
                            cursor: 'pointer',
                            padding: '0 4px',
                            borderRadius: 3,
                            fontStyle: repo.instructions ? 'normal' : 'italic',
                          }}
                          onClick={() => { setEditingInstructionsRepoId(repo.id); setInstructionsInput(repo.instructions || ''); }}
                          title="Click to edit repo-specific instructions"
                        >
                          {repo.instructions ? `${repo.instructions.slice(0, 60)}${repo.instructions.length > 60 ? '...' : ''}` : 'none (click to add)'}
                        </span>
                      )}
                    </div>
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
