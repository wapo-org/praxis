import { describe, expect, it } from 'vitest';
import { ModeSchema } from '@praxis/protocol';
import { DEFAULT_MODE, fromWireMode, MODE_LABELS, MODES, toWireMode } from './modes';

describe('modes (WP-I1): Auto, Ask, Execute', () => {
  it('offers exactly Auto, Ask and Execute', () => {
    expect(MODES.map((m) => MODE_LABELS[m])).toEqual(['Auto', 'Ask', 'Execute']);
    expect(DEFAULT_MODE).toBe('execute');
  });
  it('sends what the server accepts: Execute is Build on the wire', () => {
    for (const mode of MODES) expect(ModeSchema.safeParse(toWireMode(mode)).success).toBe(true);
    expect(toWireMode('execute')).toBe('build');
    expect(toWireMode('auto')).toBe('auto');
    expect(toWireMode('ask')).toBe('ask');
  });
  it('reads stored and synced modes: build is Execute, the retired plan becomes Auto, anything else the default', () => {
    expect(fromWireMode('build')).toBe('execute');
    expect(fromWireMode('plan')).toBe('auto');
    expect(fromWireMode('ask')).toBe('ask');
    expect(fromWireMode('auto')).toBe('auto');
    expect(fromWireMode(undefined)).toBe(DEFAULT_MODE);
    expect(fromWireMode('weird')).toBe(DEFAULT_MODE);
    for (const wire of ModeSchema.options) expect(MODES).toContain(fromWireMode(wire));
  });
});
