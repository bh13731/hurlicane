import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { validateTransition } from '../server/orchestrator/StateTransitions.js';

describe('StateTransitions', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ── Legal transitions ─────────────────────────────────────────────────

  describe('legal transitions', () => {
    it.each([
      ['job', 'queued', 'assigned'],
      ['job', 'queued', 'failed'],
      ['job', 'queued', 'cancelled'],
      ['job', 'assigned', 'running'],
      ['job', 'assigned', 'failed'],
      ['job', 'assigned', 'cancelled'],
      ['job', 'running', 'done'],
      ['job', 'running', 'failed'],
      ['job', 'running', 'cancelled'],
      ['job', 'failed', 'queued'],
    ] as const)('%s: %s → %s is valid', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: true, from, to });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['workflow', 'running', 'complete'],
      ['workflow', 'running', 'blocked'],
      ['workflow', 'running', 'failed'],
      ['workflow', 'running', 'cancelled'],
      ['workflow', 'blocked', 'running'],
      ['workflow', 'blocked', 'cancelled'],
      ['workflow', 'failed', 'running'],
    ] as const)('%s: %s → %s is valid', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: true, from, to });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['debate', 'running', 'consensus'],
      ['debate', 'running', 'disagreement'],
      ['debate', 'running', 'failed'],
      ['debate', 'running', 'cancelled'],
    ] as const)('%s: %s → %s is valid', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: true, from, to });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ── Illegal transitions ───────────────────────────────────────────────

  describe('illegal transitions', () => {
    it.each([
      ['job', 'done', 'running'],
      ['job', 'cancelled', 'running'],
      ['job', 'queued', 'done'],
      ['job', 'assigned', 'queued'],
    ] as const)('%s: %s → %s is invalid and warns', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: false, from, to });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`illegal ${entity} transition '${from}' → '${to}'`),
      );
    });

    it.each([
      ['workflow', 'complete', 'running'],
      ['workflow', 'cancelled', 'running'],
    ] as const)('%s: %s → %s is invalid and warns', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: false, from, to });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`illegal ${entity} transition '${from}' → '${to}'`),
      );
    });

    it.each([
      ['debate', 'consensus', 'running'],
      ['debate', 'disagreement', 'running'],
      ['debate', 'failed', 'running'],
      ['debate', 'cancelled', 'running'],
    ] as const)('%s: %s → %s is invalid and warns', (entity, from, to) => {
      const result = validateTransition(entity, from, to);
      expect(result).toEqual({ valid: false, from, to });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`illegal ${entity} transition '${from}' → '${to}'`),
      );
    });
  });

  // ── Unknown from-status ───────────────────────────────────────────────

  describe('unknown from-status', () => {
    it('returns invalid and warns for unknown job status', () => {
      const result = validateTransition('job', 'bogus', 'running');
      expect(result).toEqual({ valid: false, from: 'bogus', to: 'running' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown job status 'bogus' → 'running'"),
      );
    });

    it('returns invalid and warns for unknown workflow status', () => {
      const result = validateTransition('workflow', 'nonsense', 'complete');
      expect(result).toEqual({ valid: false, from: 'nonsense', to: 'complete' });
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown workflow status 'nonsense' → 'complete'"),
      );
    });
  });

  // ── Same-status no-ops ────────────────────────────────────────────────

  describe('same-status no-ops', () => {
    it.each([
      ['job', 'running'],
      ['workflow', 'blocked'],
      ['debate', 'running'],
    ] as const)('%s: %s → %s is a valid no-op without warning', (entity, status) => {
      const result = validateTransition(entity, status, status);
      expect(result).toEqual({ valid: true, from: status, to: status });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ── Undefined from-status (entity not found) ─────────────────────────

  describe('undefined from-status', () => {
    it('returns valid and skips validation when from is undefined', () => {
      const result = validateTransition('job', undefined, 'assigned');
      expect(result).toEqual({ valid: true, from: undefined, to: 'assigned' });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ── entityId truncation in warnings ───────────────────────────────────

  describe('entityId truncation', () => {
    it('truncates entityId to 8 chars in warning messages', () => {
      const longId = 'abcdef12-3456-7890-abcd-ef1234567890';
      validateTransition('job', 'done', 'running', longId);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('(abcdef12)'),
      );
      // Should NOT contain the full ID
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).not.toContain(longId);
    });

    it('omits entityId parenthetical when not provided', () => {
      validateTransition('job', 'done', 'running');
      expect(warnSpy).toHaveBeenCalledOnce();
      const msg = warnSpy.mock.calls[0][0] as string;
      expect(msg).not.toContain('(');
    });
  });
});
