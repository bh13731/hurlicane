import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DiscussionThread } from '../DiscussionThread';
import socket from '../../socket';
import type { Discussion, DiscussionMessage } from '@shared/types';
import styles from './DiscussionList.module.css';

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  question: '?',
  observation: 'i',
  alert: '!',
};

const CATEGORY_COLORS: Record<string, string> = {
  question: '#f59e0b',
  observation: '#58a6ff',
  alert: '#f85149',
};

const PRIORITY_WEIGHT: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// ─── Send to Eye ──────────────────────────────────────────────────────────────

function SendToEye({ onCreated }: { onCreated?: (discussionId: string) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/eye/discussions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        setText('');
        onCreated?.(data.discussion.id);
      }
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className={styles.sendToEye}>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKey}
        placeholder="Send a message to Eye..."
        disabled={sending}
        rows={1}
        className={styles.sendToEyeInput}
      />
      <button className="btn btn-sm btn-primary" onClick={handleSend} disabled={sending || !text.trim()}>
        {sending ? '...' : 'Send'}
      </button>
    </div>
  );
}

// ─── Discussion List ──────────────────────────────────────────────────────────

interface DiscussionListProps {
  discussions: Discussion[];
}

export function DiscussionList({ discussions }: DiscussionListProps): JSX.Element {
  const [discMessages, setDiscMessages] = useState<Record<string, DiscussionMessage[]>>({});
  const [selectedDiscId, setSelectedDiscId] = useState<string | null>(null);
  const [discFilter, setDiscFilter] = useState<'needs-reply' | 'open' | 'resolved' | 'all'>('needs-reply');

  const fetchDiscMessages = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/eye/discussions/${id}/messages`);
      const msgs = await res.json();
      setDiscMessages(prev => ({ ...prev, [id]: msgs }));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    for (const d of discussions) {
      if (!discMessages[d.id]) fetchDiscMessages(d.id);
    }
  }, [discussions]);

  useEffect(() => {
    const onDiscMsg = ({ message }: { message: DiscussionMessage }) => {
      setDiscMessages(prev => {
        const existing = prev[message.discussion_id] ?? [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [message.discussion_id]: [...existing, message] };
      });
    };
    const onDiscNew = ({ discussion, message }: { discussion: Discussion; message: DiscussionMessage }) => {
      setDiscMessages(prev => ({ ...prev, [discussion.id]: [message] }));
    };
    socket.on('eye:discussion:message', onDiscMsg);
    socket.on('eye:discussion:new', onDiscNew);
    return () => {
      socket.off('eye:discussion:message', onDiscMsg);
      socket.off('eye:discussion:new', onDiscNew);
    };
  }, []);

  const sendDiscMessage = async (discId: string, content: string) => {
    await fetch(`/api/eye/discussions/${discId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    fetchDiscMessages(discId);
  };

  const resolveDiscussion = async (id: string) => {
    await fetch(`/api/eye/discussions/${id}/resolve`, { method: 'POST' });
  };

  const reopenDiscussion = async (id: string) => {
    await fetch(`/api/eye/discussions/${id}/reopen`, { method: 'POST' });
  };

  const filteredDiscussions = discussions
    .filter(d => {
      if (discFilter === 'all') return true;
      if (discFilter === 'resolved') return d.status === 'resolved';
      if (discFilter === 'open') return d.status === 'open';
      // 'needs-reply': open discussions where last message is from Eye and requires a reply
      if (d.status !== 'open') return false;
      const msgs = discMessages[d.id];
      if (!msgs) return false; // not loaded yet — hide until messages fetch completes
      if (msgs.length === 0) return false;
      const last = msgs[msgs.length - 1];
      return last.role === 'eye' && last.requires_reply === true;
    })
    .sort((a, b) => {
      const pw = (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
      if (pw !== 0) return pw;
      return b.updated_at - a.updated_at;
    });

  return (
    <div className="eye-col">
      <div className="eye-col-header">
        <h3>Discussions</h3>
        <div className="eye-filter-tabs">
          <button className={`eye-filter-tab ${discFilter === 'needs-reply' ? 'active' : ''}`} onClick={() => setDiscFilter('needs-reply')}>Needs reply</button>
          <button className={`eye-filter-tab ${discFilter === 'open' ? 'active' : ''}`} onClick={() => setDiscFilter('open')}>Open</button>
          <button className={`eye-filter-tab ${discFilter === 'resolved' ? 'active' : ''}`} onClick={() => setDiscFilter('resolved')}>Resolved</button>
          <button className={`eye-filter-tab ${discFilter === 'all' ? 'active' : ''}`} onClick={() => setDiscFilter('all')}>All</button>
        </div>
      </div>
      <SendToEye onCreated={(id) => { setDiscFilter('open'); setSelectedDiscId(id); }} />
      <div className="eye-col-body">
        {filteredDiscussions.length === 0 && <div className="eye-empty">No discussions yet</div>}
        {filteredDiscussions.map(d => {
          const msgs = discMessages[d.id] ?? [];
          const lastMsg = msgs[msgs.length - 1];
          const hasUnread = lastMsg?.role === 'eye' && lastMsg.requires_reply === true;
          const isSelected = selectedDiscId === d.id;
          return (
            <div key={d.id} className={`eye-disc-card ${isSelected ? 'eye-disc-card-selected' : ''}`} onClick={() => setSelectedDiscId(isSelected ? null : d.id)}>
              <div className="eye-disc-card-top">
                <span className="eye-disc-icon" style={{ background: CATEGORY_COLORS[d.category], color: '#0d1117' }} title={d.category}>
                  {CATEGORY_ICONS[d.category]}
                </span>
                <span className="eye-disc-topic">{d.topic}</span>
                {d.priority === 'high' && <span className="eye-disc-priority-badge">HIGH</span>}
                {hasUnread && <span className="eye-disc-needs-reply" title="Eye replied — needs your response" />}
                <span className="eye-disc-count">{msgs.length}</span>
              </div>
              {lastMsg && (
                <div className={`eye-disc-preview ${hasUnread ? 'eye-disc-preview-unread' : ''}`}>
                  {lastMsg.content.slice(0, 120)}{lastMsg.content.length > 120 ? '...' : ''}
                </div>
              )}
              {isSelected && (
                <div className="eye-disc-thread-wrapper" onClick={e => e.stopPropagation()}>
                  <DiscussionThread
                    messages={msgs}
                    onSendMessage={(content) => sendDiscMessage(d.id, content)}
                    status={d.status}
                    onResolve={d.status === 'open' ? () => resolveDiscussion(d.id) : undefined}
                    onReopen={d.status === 'resolved' ? () => reopenDiscussion(d.id) : undefined}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
