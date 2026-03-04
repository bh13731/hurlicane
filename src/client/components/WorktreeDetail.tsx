import React, { useState, useEffect, useCallback } from 'react';
import { DiffViewer } from './DiffViewer';
import type { Worktree } from '@shared/types';

interface WorktreeDetailProps {
  worktree: Worktree;
  onDeleted: () => void;
  onClose?: () => void;
}

interface WorktreeStatus {
  synced: boolean;
  prUrl: string | null;
  prState: string | null;
  autoMerge: boolean;
}

export function WorktreeDetail({ worktree, onDeleted, onClose }: WorktreeDetailProps) {
  const [diff, setDiff] = useState('');
  const [commits, setCommits] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<WorktreeStatus | null>(null);

  const [pushState, setPushState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [pushError, setPushError] = useState('');

  const [prActionState, setPrActionState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [prActionUrl, setPrActionUrl] = useState('');
  const [prActionError, setPrActionError] = useState('');

  const [automergeState, setAutomergeState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [automergeError, setAutomergeError] = useState('');

  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const fetchStatus = useCallback((signal?: AbortSignal) => {
    fetch(`/api/worktrees/${worktree.id}/status`, { signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setStatus(data); })
      .catch(err => { if (err.name !== 'AbortError') { /* ignore */ } });
  }, [worktree.id]);

  useEffect(() => {
    const controller = new AbortController();

    setLoading(true);
    setError(null);
    setDiff('');
    setCommits('');
    setStatus(null);
    setPushState('idle');
    setPrActionState('idle');
    setPrActionUrl('');
    setAutomergeState('idle');
    setDeleteConfirm(false);

    fetch(`/api/worktrees/${worktree.id}/diff`, { signal: controller.signal })
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
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    fetchStatus(controller.signal);

    return () => controller.abort();
  }, [worktree.id, fetchStatus]);

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
      fetchStatus();
    } catch (err: any) {
      setPushError(err.message);
      setPushState('error');
    }
  };

  const handleCreatePR = async () => {
    setPrActionState('loading');
    setPrActionError('');
    setPrActionUrl('');
    try {
      const res = await fetch(`/api/worktrees/${worktree.id}/pr`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create PR');
      }
      const data = await res.json();
      setPrActionUrl(data.url);
      setPrActionState('success');
      fetchStatus();
    } catch (err: any) {
      setPrActionError(err.message);
      setPrActionState('error');
    }
  };

  const handleAutomerge = async () => {
    setAutomergeState('loading');
    setAutomergeError('');
    try {
      const res = await fetch(`/api/worktrees/${worktree.id}/automerge`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to enable auto-merge');
      }
      setAutomergeState('idle');
      fetchStatus();
    } catch (err: any) {
      setAutomergeError(err.message);
      setAutomergeState('error');
    }
  };

  const handleDelete = async () => {
    try {
      await fetch(`/api/worktrees/${worktree.id}`, { method: 'DELETE' });
      onDeleted();
    } catch { /* ignore */ }
  };

  const isSynced = status?.synced === true;
  const hasPR = status?.prUrl != null;
  const isAutoMerge = status?.autoMerge === true;

  return (
    <div className="worktree-detail">
      <div className="worktree-detail-header">
        <div className="worktree-detail-title">{worktree.branch}</div>
        <div className="worktree-detail-path">{worktree.path}</div>
        {onClose && (
          <button className="worktree-detail-close" onClick={onClose} title="Close">✕</button>
        )}
      </div>

      <div className="worktree-actions">
        <button
          className={`worktree-action-btn worktree-action-push${isSynced ? ' worktree-action-btn--active' : ''}`}
          onClick={handlePush}
          disabled={pushState === 'loading' || isSynced}
        >
          {pushState === 'loading' ? 'Pushing...' : isSynced ? 'Pushed' : pushState === 'success' ? 'Pushed' : 'Push'}
        </button>

        {hasPR ? (
          <a
            className="worktree-action-btn worktree-action-pr worktree-action-btn--active"
            href={status!.prUrl!}
            target="_blank"
            rel="noopener noreferrer"
          >
            View PR
          </a>
        ) : (
          <button
            className="worktree-action-btn worktree-action-pr"
            onClick={handleCreatePR}
            disabled={prActionState === 'loading'}
          >
            {prActionState === 'loading' ? 'Creating...' : 'Create PR'}
          </button>
        )}

        {hasPR && (
          isAutoMerge ? (
            <span className="worktree-action-btn worktree-action-automerge worktree-action-btn--active" style={{ cursor: 'default' }}>
              Auto-merge On
            </span>
          ) : (
            <button
              className="worktree-action-btn worktree-action-automerge"
              onClick={handleAutomerge}
              disabled={automergeState === 'loading'}
            >
              {automergeState === 'loading' ? 'Enabling...' : 'Set Automerge'}
            </button>
          )
        )}

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
      {prActionState === 'success' && prActionUrl && (
        <div className="worktree-pr-link">
          PR created: <a href={prActionUrl} target="_blank" rel="noopener noreferrer">{prActionUrl}</a>
        </div>
      )}
      {prActionState === 'error' && <div className="worktree-error">{prActionError}</div>}
      {automergeState === 'error' && <div className="worktree-error">{automergeError}</div>}

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
