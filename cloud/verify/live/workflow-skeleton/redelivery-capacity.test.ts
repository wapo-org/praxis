import {describe, expect, it} from 'vitest';
import type {TurnResult} from '@praxis/protocol';
import {capacityChecks, canonicalFlags, redeliveryChecks, settledRunsChecks, type TurnRowValue} from './redelivery-capacity.js';

const flags: TurnResult = {done: false, status: 'ready', subagents: [], turnIndex: 0};

const row: TurnRowValue = {
  _creationTime: 1,
  userId: 'owner',
  runId: 'run',
  generation: 0,
  turnIndex: 0,
  done: false,
  status: 'ready',
};

describe('workflow redelivery checks', () => {
  it('accepts identical concurrent replies backed by one turn row', () => {
    const checks = redeliveryChecks('concurrent', [
      {ok: true, value: flags},
      {ok: true, value: {...flags}},
    ], [row], flags);

    expect(checks.every(result => result.ok)).toBe(true);
    expect(canonicalFlags(flags)).toBe('{"done":false,"status":"ready","subagents":[],"turnIndex":0}');
  });

  it('rejects duplicate rows or divergent replies', () => {
    const checks = redeliveryChecks('concurrent', [
      {ok: true, value: flags},
      {ok: true, value: {...flags, done: true, status: 'completed'}},
    ], [row, {...row, _creationTime: 2}], flags);

    expect(checks.some(result => !result.ok)).toBe(true);
    expect(checks.find(result => result.name.endsWith('one turns row for index 0'))?.ok).toBe(false);
  });

  it('checks hosted parallelism against the S16 and S256 scheduled-job limits', () => {
    const checks = capacityChecks(4, 4);

    expect(checks.every(result => result.ok)).toBe(true);
    expect(checks.find(result => result.name.includes('S16'))?.observed).toContain('headroom 2');
  });

  it('requires all concurrently started runs to complete', () => {
    expect(settledRunsChecks([
      null, null, null, null, null,
    ], 5)[0]?.ok).toBe(false);
  });
});
