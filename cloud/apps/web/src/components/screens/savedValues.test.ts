import { describe, expect, it } from 'vitest';
import { keepRow, previewValue, SAVED_PAGE, savedQuery } from './SavedSecrets';

describe('Secrets & variables queries (WP-L2 §5)', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  it('maps each filter onto the saved-values query', () => {
    expect(savedQuery('all', '  ', now)).toEqual({ query: undefined, kind: undefined, since: undefined, limit: SAVED_PAGE });
    expect(savedQuery('secret', 'tok', now)).toMatchObject({ query: 'tok', kind: 'secret' });
    expect(savedQuery('variable', '', now)).toMatchObject({ kind: 'variable' });
    expect(savedQuery('week', '', now).since).toBe('2026-11-05T12:00:00.000Z');
    expect(savedQuery('unused', '', now)).toMatchObject({ kind: undefined, since: undefined });
  });
  it('applies Unused on the client', () => {
    const row = { id: '1', name: 'a', kind: 'variable' as const, createdAt: '' };
    expect(keepRow('unused', { ...row, lastUsedAt: null })).toBe(true);
    expect(keepRow('unused', { ...row, lastUsedAt: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(keepRow('all', { ...row, lastUsedAt: '2026-11-01T00:00:00Z' })).toBe(true);
  });
  it('previews a variable on one line', () => {
    expect(previewValue('a\n  b')).toBe('a b');
    expect(previewValue({ region: 'eu', n: 2 })).toBe('{"region":"eu","n":2}');
    expect(previewValue(undefined)).toBe('null');
  });
});
