import { describe, expect, it } from 'vitest';

describe('KBConsolidator JSON extraction', () => {
  it('extracts a bare JSON array', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    expect(extractFirstJsonArray('["a","b"]')).toBe('["a","b"]');
  });

  it('extracts the first array when commentary follows on later lines', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    const input = '[]\nNo contradictions found for [entry-123]';
    expect(extractFirstJsonArray(input)).toBe('[]');
  });

  it('ignores brackets inside JSON strings', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    const input = '[\"id-with-]\", \"other\"]\nAdditional note [ignored]';
    expect(extractFirstJsonArray(input)).toBe('[\"id-with-]\", \"other\"]');
  });

  it('returns null when no array is present', async () => {
    const { extractFirstJsonArray } = await import('../server/orchestrator/KBConsolidator.js');
    expect(extractFirstJsonArray('No JSON here')).toBeNull();
  });
});
