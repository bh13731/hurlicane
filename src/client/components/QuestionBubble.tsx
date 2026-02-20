import React, { useState } from 'react';
import type { Question } from '@shared/types';

interface QuestionBubbleProps {
  question: Question;
}

export function QuestionBubble({ question }: QuestionBubbleProps) {
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!answer.trim() || loading || sent) return;
    setLoading(true);
    try {
      await fetch(`/api/replies/${question.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answer.trim() }),
      });
      setSent(true);
    } catch (err) {
      console.error('Failed to submit reply:', err);
    } finally {
      setLoading(false);
    }
  };

  if (sent || question.status !== 'pending') {
    return (
      <div className="question-bubble question-bubble-answered">
        <div className="question-text">{question.question}</div>
        {question.answer && <div className="question-answer">Answer: {question.answer}</div>}
      </div>
    );
  }

  return (
    <div className="question-bubble question-bubble-pending">
      <div className="question-label">Agent is asking:</div>
      <div className="question-text">{question.question}</div>
      <form onSubmit={handleSubmit} className="question-form">
        <input
          type="text"
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          placeholder="Your answer..."
          autoFocus
          disabled={loading}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !answer.trim()}>
          {loading ? '...' : 'Send'}
        </button>
      </form>
    </div>
  );
}
