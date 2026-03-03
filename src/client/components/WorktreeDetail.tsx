import React, { useState, useEffect } from 'react';
import { DiffViewer } from './DiffViewer';
import type { Worktree } from '@shared/types';

interface WorktreeDetailProps {
  worktree: Worktree;
  onDeleted: () => void;
}

export function WorktreeDetail({ worktree, onDeleted }: WorktreeDetailProps) {
  const [diff, setDiff] = useState('');
  const [commits, setCommits] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pushState, setPushState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [pushError, setPushError] = useState('');

  const [prState, setPrState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [prUrl, setPrUrl] = useState('');
  const [prError, setPrError] = useState('');

  const [deleteConfirm, setDeleteConfirm] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setDiff('');
    setCommits('');
    setPushState('idle');
    setPrState('idle');
    setDeleteConfirm(false);

    fetch(`/api/worktrees/${worktree.id}/diff`)
      .then(async res => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to load diff');
        }
        return res.json();
      })
      .then(data => {
        setDiff(data.diff);
        setCommits(data.commits);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [worktree.id]);

  const handlePush = async () => {
    setPushState('loading');
    setPushError('');
    try {
      const res = await fetch(`/api/worktrees/${worktree.id}/push`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Push failed');
      }
      setPushState('success');
    } catch (err: any) {
      setPushError(err.message);
      setPushState('error');
    }
  };

  const handlePR = async () => {
    setPrState('loading');
    setPrError('');
    setPrUrl('');
    try {
      const res = await fetch(`/api/worktrees/${worktree.id}/pr`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create PR');
      }
      const data = await res.json();
      setPrUrl(data.url);
      setPrState('success');
    } catch (err: any) {
      setPrError(err.message);
      setPrState('error');
    }
  };

  const handleDelete = async () => {
    try {
      await fetch(`/api/worktrees/${worktree.id}`, { method: 'DELETE' });
      onDeleted();
    } catch { /* ignore */ }
  };

  return (
    <div className="worktree-detail">
      <div className="worktree-detail-header">
        <div className="worktree-detail-title">{worktree.branch}</div>
        <div className="worktree-detail-path">{worktree.path}</div>
      </div>

      <div className="worktree-actions">
        <button
          className="worktree-action-btn worktree-action-push"
          onClick={handlePush}
          disabled={pushState === 'loading'}
        >
          {pushState === 'loading' ? 'Pushing...' : pushState === 'success' ? 'Pushed' : 'Push'}
        </button>

        <button
          className="worktree-action-btn worktree-action-pr"
          onClick={handlePR}
          disabled={prState === 'loading'}
        >
          {prState === 'loading' ? 'Creating...' : 'Create PR'}
        </button>

        {!deleteConfirm ? (
          <button
            className="worktree-action-btn worktree-action-delete"
            onClick={() => setDeleteConfirm(true)}
          >
            Delete
          </button>
        ) : (
          <button
            className="worktree-action-btn worktree-action-delete worktree-action-delete--confirm"
            onClick={handleDelete}
          >
            Confirm Delete
          </button>
        )}
      </div>

      {pushState === 'error' && <div className="worktree-error">{pushError}</div>}
      {prState === 'success' && prUrl && (
        <div className="worktree-pr-link">
          PR created: <a href={prUrl} target="_blank" rel="noopener noreferrer">{prUrl}</a>
        </div>
      )}
      {prState === 'error' && <div className="worktree-error">{prError}</div>}

      {commits && (
        <div className="worktree-commits">
          <div className="worktree-commits-label">Commits</div>
          <pre className="worktree-commits-list">{commits}</pre>
        </div>
      )}

      <div className="worktree-diff">
        {loading && <div className="worktree-diff-loading">Loading diff...</div>}
        {error && <div className="worktree-error">{error}</div>}
        {!loading && !error && <DiffViewer diff={diff} />}
      </div>
    </div>
  );
}
