// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ToastFeed } from '../../client/components/ToastFeed';
import type { Toast } from '../../client/hooks/useToasts';
import './setup';

function makeToast(overrides: Partial<Toast> = {}): Toast {
  return {
    id: `toast-${Math.random().toString(36).slice(2)}`,
    type: 'info', message: 'Test notification', timestamp: Date.now(), ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('ToastFeed', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastFeed toasts={[]} dismiss={vi.fn()} />);
    expect(container.querySelector('.toast-container')).toBeNull();
  });

  it('renders toast messages', () => {
    const toasts = [makeToast({ message: 'Job completed' }), makeToast({ message: 'New job queued' })];
    render(<ToastFeed toasts={toasts} dismiss={vi.fn()} />);
    expect(screen.getByText('Job completed')).toBeInTheDocument();
    expect(screen.getByText('New job queued')).toBeInTheDocument();
  });

  it('applies correct toast type class', () => {
    const toasts = [
      makeToast({ id: 'err', type: 'error', message: 'Failed' }),
      makeToast({ id: 'ok', type: 'success', message: 'Done' }),
    ];
    const { container } = render(<ToastFeed toasts={toasts} dismiss={vi.fn()} />);
    expect(container.querySelector('.toast-error')).toBeTruthy();
    expect(container.querySelector('.toast-success')).toBeTruthy();
  });

  it('calls dismiss when close button is clicked', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();
    const { container } = render(<ToastFeed toasts={[makeToast({ id: 'toast-1', message: 'Dismiss me' })]} dismiss={dismiss} />);
    fireEvent.click(container.querySelector('.toast-close')!);
    vi.advanceTimersByTime(300);
    expect(dismiss).toHaveBeenCalledWith('toast-1');
  });

  it('calls onSelectAgent when toast body is clicked and agentId is present', () => {
    vi.useFakeTimers();
    const onSelectAgent = vi.fn();
    const dismiss = vi.fn();
    render(<ToastFeed toasts={[makeToast({ id: 'toast-a', message: 'Agent done', agentId: 'agent-xyz' })]} dismiss={dismiss} onSelectAgent={onSelectAgent} />);
    fireEvent.click(screen.getByText('Agent done'));
    expect(onSelectAgent).toHaveBeenCalledWith('agent-xyz');
    vi.advanceTimersByTime(300);
  });

  it('shows relative time for recent toasts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    render(<ToastFeed toasts={[makeToast({ message: 'Recent', timestamp: Date.now() })]} dismiss={vi.fn()} />);
    expect(screen.getByText('just now')).toBeInTheDocument();
  });
});
