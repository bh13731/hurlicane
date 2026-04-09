// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../../client/socket', () => {
  const _listeners = new Map<string, Set<Function>>();
  return {
    default: {
      connected: false,
      _listeners,
      on: (event: string, fn: Function) => {
        if (!_listeners.has(event)) _listeners.set(event, new Set());
        _listeners.get(event)!.add(fn);
      },
      off: (event: string, fn: Function) => { _listeners.get(event)?.delete(fn); },
      emit: vi.fn(),
      onAny: vi.fn(),
    },
  };
});

import socket from '../../client/socket';
import { useSocket } from '../../client/hooks/useSocket';
import { makeAgent, makeJob } from './factories';

const mockSocket = socket as unknown as {
  connected: boolean;
  _listeners: Map<string, Set<Function>>;
  emit: ReturnType<typeof vi.fn>;
};

function emitEvent(event: string, payload: unknown) {
  const fns = mockSocket._listeners.get(event);
  if (fns) for (const fn of fns) fn(payload);
}

function makeHandlers() {
  return {
    onSnapshot: vi.fn(), onAgentNew: vi.fn(), onAgentUpdate: vi.fn(),
    onAgentOutput: vi.fn(), onQuestionNew: vi.fn(), onQuestionAnswered: vi.fn(),
    onLockAcquired: vi.fn(), onLockReleased: vi.fn(), onJobNew: vi.fn(), onJobUpdate: vi.fn(),
  };
}

describe('useSocket', () => {
  beforeEach(() => {
    mockSocket._listeners.clear();
    mockSocket.emit.mockClear();
    mockSocket.connected = false;
  });

  it('registers listeners for all required events on mount', () => {
    renderHook(() => useSocket(makeHandlers()));
    const events = [...mockSocket._listeners.keys()];
    expect(events).toContain('queue:snapshot');
    expect(events).toContain('agent:new');
    expect(events).toContain('agent:update');
    expect(events).toContain('job:new');
    expect(events).toContain('job:update');
    expect(events).toContain('lock:acquired');
    expect(events).toContain('lock:released');
  });

  it('cleans up all listeners on unmount', () => {
    const { unmount } = renderHook(() => useSocket(makeHandlers()));
    expect(mockSocket._listeners.get('agent:new')?.size).toBeGreaterThan(0);
    unmount();
    for (const [, fns] of mockSocket._listeners) expect(fns.size).toBe(0);
  });

  it('requests snapshot when socket is already connected', () => {
    mockSocket.connected = true;
    renderHook(() => useSocket(makeHandlers()));
    expect(mockSocket.emit).toHaveBeenCalledWith('request:snapshot');
  });

  it('does not request snapshot when socket is not connected', () => {
    mockSocket.connected = false;
    renderHook(() => useSocket(makeHandlers()));
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('dispatches agent:new events to the handler', () => {
    const handlers = makeHandlers();
    renderHook(() => useSocket(handlers));
    emitEvent('agent:new', { agent: makeAgent() });
    expect(handlers.onAgentNew).toHaveBeenCalled();
  });

  it('dispatches job:new events to the handler', () => {
    const handlers = makeHandlers();
    renderHook(() => useSocket(handlers));
    emitEvent('job:new', { job: makeJob() });
    expect(handlers.onJobNew).toHaveBeenCalled();
  });
});
