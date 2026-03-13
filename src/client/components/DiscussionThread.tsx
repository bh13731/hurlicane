import React, { useState, useRef, useEffect } from 'react';

interface Message {
  role: 'eye' | 'user';
  content: string;
  created_at: number;
}

interface DiscussionThreadProps {
  messages: Message[];
  onSendMessage: (content: string) => void;
  status: 'open' | 'resolved' | 'stale';
  onResolve?: () => void;
  onReopen?: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export function DiscussionThread({ messages, onSendMessage, status, onResolve, onReopen }: DiscussionThreadProps) {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      await onSendMessage(input.trim());
      setInput('');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="eye-thread">
      <div className="eye-thread-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`eye-msg eye-msg-${msg.role}`}>
            <div className="eye-msg-header">
              <span className="eye-msg-role">{msg.role === 'eye' ? 'Eye' : 'You'}</span>
              <span className="eye-msg-time">{formatTime(msg.created_at)}</span>
            </div>
            <div className="eye-msg-content">{msg.content}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {status === 'open' && (
        <form onSubmit={handleSubmit} className="eye-thread-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(e as any); } }}
            placeholder="Reply..."
            disabled={sending}
            rows={1}
            style={{ resize: 'none', overflow: 'hidden' }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !input.trim()}>
            Send
          </button>
          {onResolve && (
            <button type="button" className="btn btn-sm eye-btn-resolve" onClick={onResolve}>
              Resolve
            </button>
          )}
        </form>
      )}
      {status === 'resolved' && onReopen && (
        <div className="eye-thread-resolved">
          <span>Resolved</span>
          <button className="btn btn-sm" onClick={onReopen}>Reopen</button>
        </div>
      )}
    </div>
  );
}
