import {describe, expect, it} from 'vitest';
import {inspect} from 'node:util';
import {pool} from './index.js';
import {revealedSlots} from './testing.js';

describe('credential pool discovery', () => {
  it('reads a single key as slot 1', () => {
    const p = pool('EXA_API_KEY', {EXA_API_KEY: 'k1'});
    expect(p).toMatchObject({service: 'exa_api_key', warnings: []});
    expect(revealedSlots(p)).toEqual([{slot: 1, credential: 'k1'}]);
  });

  it('reads three numbered keys in order', () => {
    const p = pool('EXA_API_KEY', {EXA_API_KEY_3: 'k3', EXA_API_KEY: 'k1', EXA_API_KEY_2: ' k2 ', EXA_API_KEY_OTHER: 'x', OTHER_EXA_API_KEY_2: 'y'});
    expect(revealedSlots(p)).toEqual([{slot: 1, credential: 'k1'}, {slot: 2, credential: 'k2'}, {slot: 3, credential: 'k3'}]);
    expect(p.warnings).toEqual([]);
  });

  it('ignores slots after a gap and warns with their names, never their values', () => {
    const p = pool('EXA_API_KEY', {EXA_API_KEY: 'k1', EXA_API_KEY_2: '  ', EXA_API_KEY_3: 'secret-three', EXA_API_KEY_5: 'secret-five'});
    expect(p.slots.map(s => s.slot)).toEqual([1]);
    expect(p.warnings).toHaveLength(2);
    expect(p.warnings[0]).toContain('EXA_API_KEY_3 is ignored');
    expect(p.warnings[0]).toContain('EXA_API_KEY_2 is missing');
    expect(p.warnings[1]).toContain('EXA_API_KEY_5');
    expect(p.warnings.join()).not.toMatch(/secret/);
  });

  it('treats a missing slot 1 as an empty pool and warns about NAME_1 and later slots', () => {
    const p = pool('EXA_API_KEY', {EXA_API_KEY: '', EXA_API_KEY_1: 'a', EXA_API_KEY_2: 'b'});
    expect(p.slots).toEqual([]);
    expect(p.warnings).toEqual([expect.stringContaining('EXA_API_KEY_1 is ignored: slot 1'), expect.stringContaining('EXA_API_KEY_2 is ignored: EXA_API_KEY is missing')]);
    expect(pool('EXA_API_KEY', {})).toMatchObject({slots: [], warnings: []});
  });

  it('groups multi-part credentials by suffix', () => {
    const p = pool(['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], {MODAL_TOKEN_ID: 'i1', MODAL_TOKEN_SECRET: 's1', MODAL_TOKEN_ID_2: 'i2', MODAL_TOKEN_SECRET_2: 's2'}, {service: 'modal'});
    expect(p.service).toBe('modal');
    expect(revealedSlots(p)).toEqual([
      {slot: 1, credential: {MODAL_TOKEN_ID: 'i1', MODAL_TOKEN_SECRET: 's1'}},
      {slot: 2, credential: {MODAL_TOKEN_ID: 'i2', MODAL_TOKEN_SECRET: 's2'}},
    ]);
  });

  it('throws on a half-defined multi-part slot, naming variables but not values', () => {
    const env = {MODAL_TOKEN_ID: 'i1', MODAL_TOKEN_SECRET: 's1', MODAL_TOKEN_ID_2: 'id-two-secret', MODAL_TOKEN_SECRET_2: ' '};
    let message = '';
    try { pool(['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], env); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/slot 2 .* half-defined: MODAL_TOKEN_SECRET_2 is missing/);
    expect(message).not.toContain('id-two-secret');
    expect(() => pool(['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], {MODAL_TOKEN_SECRET: 's1'})).toThrow(/slot 1/);
  });

  it('makes EXA_API_KEY_3 selectable as soon as it is in the environment', () => {
    const env: Record<string, string> = {EXA_API_KEY: 'k1', EXA_API_KEY_2: 'k2'};
    expect(pool('EXA_API_KEY', env).slots.map(s => s.slot)).toEqual([1, 2]);
    env.EXA_API_KEY_3 = 'k3';
    expect(revealedSlots(pool('EXA_API_KEY', env)).at(-1)).toEqual({slot: 3, credential: 'k3'});
  });

  it('never prints a key value when a pool is logged or serialised', () => {
    const single = pool('EXA_API_KEY', {EXA_API_KEY: 'sk-single-value', EXA_API_KEY_2: 'sk-second-value'});
    const multi = pool(['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], {MODAL_TOKEN_ID: 'id-value-one', MODAL_TOKEN_SECRET: 'secret-value-one'});
    const printed = [JSON.stringify(single), JSON.stringify(multi), inspect(single, {depth: null}), inspect(multi, {depth: null}), String(single.slots[0]!.credential)].join('\n');
    for (const value of ['sk-single-value', 'sk-second-value', 'id-value-one', 'secret-value-one']) expect(printed).not.toContain(value);
    expect(printed).toContain('[redacted]');
  });

  it('rejects names that are not environment variable names', () => {
    expect(() => pool('exa key', {})).toThrow();
    expect(() => pool([], {})).toThrow();
  });
});
