import React, { useState, useEffect, useCallback, useRef } from 'react';
import socket from '../../socket';
import styles from './PRReviewList.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PrReview {
  id: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  pr_author: string | null;
  repo: string;
  summary: string;
  comments: string;
  status: string;
  github_review_id: string | null;
  needs_reply?: boolean;
  created_at: number;
  updated_at: number;
}

interface PrReviewMessage {
  id: string;
  review_id: string;
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

interface ReviewComment {
  file: string;
  line?: number;
  body: string;
  severity: 'info' | 'suggestion' | 'warning' | 'issue';
  codex_confirmed?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  info: 'var(--text-dim)',
  suggestion: '#58a6ff',
  warning: '#f59e0b',
  issue: '#f85149',
};

const SEVERITY_ICONS: Record<string, string> = {
  info: 'ℹ',
  suggestion: '💡',
  warning: '⚠️',
  issue: '🔴',
};

// ─── AutoResizeTextarea ───────────────────────────────────────────────────────

function AutoResizeTextarea({ value, onChange, onSubmit, placeholder, style }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
      placeholder={placeholder}
      rows={1}
      style={{ resize: 'none', overflow: 'hidden', fontFamily: 'inherit', lineHeight: 1.4, ...style }}
    />
  );
}

// ─── PRReviewList ─────────────────────────────────────────────────────────────

export function PRReviewList(): JSX.Element {
  const [reviews, setReviews] = useState<PrReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<Record<string, PrReviewMessage[]>>({});
  const [replyInputs, setReplyInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const [deleteReasons, setDeleteReasons] = useState<Record<string, string>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Record<string, boolean>>({});

  const fetchReviews = useCallback(async () => {
    try {
      const res = await fetch('/api/eye/pr-reviews');
      if (res.ok) {
        const data: PrReview[] = await res.json();
        setReviews(data);
        // Load messages for all reviews
        const msgs: Record<string, PrReviewMessage[]> = {};
        await Promise.all(data.map(async r => {
          try {
            const mr = await fetch(`/api/eye/pr-reviews/${r.id}/messages`);
            if (mr.ok) msgs[r.id] = await mr.json();
          } catch { /* ignore */ }
        }));
        setMessages(msgs);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchReviews(); }, [fetchReviews]);

  useEffect(() => {
    const onNew = ({ review }: { review: PrReview }) => {
      setReviews(prev => [review, ...prev.filter(r => r.id !== review.id)]);
    };
    const onUpdate = ({ review }: { review: PrReview }) => {
      if (review.status === 'dismissed') {
        setReviews(prev => prev.filter(r => r.id !== review.id));
      } else {
        setReviews(prev => prev.map(r => r.id === review.id ? review : r));
      }
    };
    const onMessage = ({ message }: { message: PrReviewMessage }) => {
      setMessages(prev => ({
        ...prev,
        [message.review_id]: [...(prev[message.review_id] ?? []), message],
      }));
    };
    socket.on('eye:pr-review:new', onNew);
    socket.on('eye:pr-review:update', onUpdate);
    socket.on('eye:pr-review:message', onMessage);
    return () => {
      socket.off('eye:pr-review:new', onNew);
      socket.off('eye:pr-review:update', onUpdate);
      socket.off('eye:pr-review:message', onMessage);
    };
  }, []);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const sendMessage = async (reviewId: string) => {
    const content = replyInputs[reviewId]?.trim();
    if (!content) return;
    setReplyInputs(prev => ({ ...prev, [reviewId]: '' }));
    try {
      await fetch(`/api/eye/pr-reviews/${reviewId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
      });
    } catch { /* ignore */ }
  };

  const submitToGitHub = async (reviewId: string) => {
    setSubmitting(prev => ({ ...prev, [reviewId]: true }));
    try {
      const res = await fetch(`/api/eye/pr-reviews/${reviewId}/submit`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json();
        alert(`Submit failed: ${err.error}`);
      }
    } catch { /* ignore */ }
    setSubmitting(prev => ({ ...prev, [reviewId]: false }));
  };

  const deleteReview = async (reviewId: string) => {
    setDeleting(prev => ({ ...prev, [reviewId]: true }));
    try {
      const res = await fetch(`/api/eye/pr-reviews/${reviewId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReasons[reviewId] || '' }),
      });
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.id !== reviewId));
        setShowDeleteConfirm(prev => ({ ...prev, [reviewId]: false }));
        setDeleteReasons(prev => ({ ...prev, [reviewId]: '' }));
      } else {
        const err = await res.json();
        alert(`Delete failed: ${err.error}`);
      }
    } catch { /* ignore */ }
    setDeleting(prev => ({ ...prev, [reviewId]: false }));
  };

  if (loading) return <div className="eye-empty">Loading...</div>;
  if (reviews.length === 0) return <div className="eye-empty">No PR reviews yet. Eye will review open PRs and show findings here.</div>;

  return (
    <div className={styles.list}>
      {reviews.map(review => {
        let comments: ReviewComment[] = [];
        try { comments = JSON.parse(review.comments); } catch { /* ignore */ }
        const isExpanded = expandedIds.has(review.id);
        const reviewMessages = messages[review.id] ?? [];
        const severityCounts = comments.reduce<Record<string, number>>((acc, c) => {
          acc[c.severity] = (acc[c.severity] || 0) + 1;
          return acc;
        }, {});
        const severitySummary = ['issue', 'warning', 'suggestion', 'info']
          .filter(s => severityCounts[s])
          .map(s => `${severityCounts[s]} ${s}${severityCounts[s]! > 1 ? 's' : ''}`)
          .join(', ');
        const isDraft = review.status === 'draft';
        const hasGhReview = !!review.github_review_id;

        return (
          <div
            key={review.id}
            className={styles.card}
            style={{ borderColor: review.needs_reply ? 'var(--accent)' : 'var(--border)' }}
          >
            <div className={styles.cardHeader}>
              <div className={styles.cardMeta}>
                <div className={styles.cardTitle}>
                  <a
                    href={review.pr_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.prLink}
                  >
                    PR #{review.pr_number} — {review.pr_title}
                  </a>
                  {review.needs_reply && (
                    <span className={styles.badgeNeedsReply}>needs reply</span>
                  )}
                  {review.status === 'submitted' && (
                    <span className={styles.badgeSubmitted}>submitted</span>
                  )}
                  {isDraft && hasGhReview && (
                    <span className={styles.badgePending}>pending on GitHub</span>
                  )}
                </div>
                <div className={styles.cardSubMeta}>
                  {review.pr_author && <span>by {review.pr_author}</span>}
                  {comments.length > 0 && <span>{review.pr_author ? ' · ' : ''}{comments.length} comment{comments.length !== 1 ? 's' : ''}</span>}
                  {severitySummary && <span> · {severitySummary}</span>}
                </div>
              </div>
              <div className={styles.cardActions}>
                {isDraft && hasGhReview && (
                  <button
                    onClick={() => submitToGitHub(review.id)}
                    disabled={submitting[review.id]}
                    className={styles.btnSubmit}
                    style={{ opacity: submitting[review.id] ? 0.6 : 1 }}
                  >
                    {submitting[review.id] ? 'Submitting…' : 'Submit review'}
                  </button>
                )}
                {review.status !== 'dismissed' && (
                  <button
                    onClick={() => setShowDeleteConfirm(prev => ({ ...prev, [review.id]: !prev[review.id] }))}
                    className={styles.btnDelete}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {showDeleteConfirm[review.id] && (
              <div className={styles.deleteConfirm}>
                <div className={styles.deleteConfirmText}>
                  Delete this review? It will be removed from GitHub if pending.
                </div>
                <input
                  type="text"
                  value={deleteReasons[review.id] ?? ''}
                  onChange={e => setDeleteReasons(prev => ({ ...prev, [review.id]: e.target.value }))}
                  placeholder="Optional: why are you deleting this? (helps Eye learn)"
                  className={styles.deleteReasonInput}
                />
                <div className={styles.deleteConfirmActions}>
                  <button
                    onClick={() => deleteReview(review.id)}
                    disabled={deleting[review.id]}
                    className={styles.btnConfirmDelete}
                    style={{ opacity: deleting[review.id] ? 0.6 : 1 }}
                  >
                    {deleting[review.id] ? 'Deleting…' : 'Confirm delete'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(prev => ({ ...prev, [review.id]: false }))}
                    className={styles.btnCancelDelete}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {review.summary && (
              <div
                className={styles.summary}
                style={{
                  WebkitLineClamp: isExpanded ? undefined : 2,
                  display: isExpanded ? 'block' : '-webkit-box',
                }}
              >
                {review.summary}
              </div>
            )}

            {comments.length > 0 && (
              <div className={styles.commentsSection}>
                <button
                  onClick={() => toggleExpanded(review.id)}
                  className={styles.toggleComments}
                >
                  {isExpanded ? '▾ Hide comments' : `▸ Show ${comments.length} comment${comments.length !== 1 ? 's' : ''}`}
                </button>
                {isExpanded && (
                  <div className={styles.commentsList}>
                    {comments.map((c, i) => (
                      <div
                        key={i}
                        className={styles.comment}
                        style={{ borderColor: `${SEVERITY_COLORS[c.severity] || 'var(--border)'}33` }}
                      >
                        <div className={styles.commentFile}>
                          {c.file}{c.line ? `:${c.line}` : ''}
                        </div>
                        <div className={styles.commentBody} style={{ color: SEVERITY_COLORS[c.severity] || 'var(--text-primary)' }}>
                          {SEVERITY_ICONS[c.severity] || ''} {c.body}
                        </div>
                        {c.codex_confirmed && (
                          <span className={styles.codexConfirmed}>✓ Codex confirmed</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Message thread */}
            {reviewMessages.length > 0 && (
              <div className={styles.messageThread}>
                {reviewMessages.map(msg => (
                  <div
                    key={msg.id}
                    className={styles.message}
                    style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start' }}
                  >
                    <div className={styles.messageRole}>{msg.role === 'user' ? 'You' : 'Eye'}</div>
                    {msg.content}
                  </div>
                ))}
              </div>
            )}

            {/* Reply input */}
            <div className={styles.replyRow}>
              <AutoResizeTextarea
                value={replyInputs[review.id] ?? ''}
                onChange={v => setReplyInputs(prev => ({ ...prev, [review.id]: v }))}
                onSubmit={() => sendMessage(review.id)}
                placeholder="Reply to Eye about this review…"
                style={{
                  flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 5,
                  border: '1px solid var(--border)', background: 'var(--bg-primary)',
                  color: 'var(--text-primary)', outline: 'none',
                }}
              />
              <button
                onClick={() => sendMessage(review.id)}
                disabled={!replyInputs[review.id]?.trim()}
                className={styles.btnSend}
                style={{ opacity: !replyInputs[review.id]?.trim() ? 0.4 : 1 }}
              >
                Send
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
