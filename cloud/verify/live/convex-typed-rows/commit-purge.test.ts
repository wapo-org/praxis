import {describe, expect, it} from 'vitest';
import {changedTables, journalRowsFor, nonEmptyTables, ownerRowCount, sequenceProblems, type RowCounts} from './commit-purge.js';

const ZERO: RowCounts = {chats: 0, messages: 0, runs: 0, turns: 0, sandboxes: 0, outputs: 0};

describe('sequenceProblems', () => {
  it('accepts a contiguous permutation', () => {
    expect(sequenceProblems([3, 1, 2, 5, 4])).toEqual([]);
  });
  it('reports gaps and duplicates', () => {
    expect(sequenceProblems([1, 2, 2, 4])).toEqual(['duplicate 2', 'gap at 3']);
  });
  it('honours a non-default first sequence', () => {
    expect(sequenceProblems([7, 8, 9], 7)).toEqual([]);
    expect(sequenceProblems([8, 9], 7)).toEqual(['gap at 7']);
  });
});

describe('row counts', () => {
  it('counts only rows owned by the user and ignores malformed rows', () => {
    expect(ownerRowCount([{userId: 'a'}, {userId: 'b'}, {userId: 'a'}, {other: 1}, null], 'a')).toBe(2);
  });
  it('lists non-empty tables', () => {
    expect(nonEmptyTables(ZERO)).toEqual([]);
    expect(nonEmptyTables({...ZERO, messages: 3})).toEqual(['messages=3']);
  });
  it('lists changed tables', () => {
    expect(changedTables(ZERO, ZERO)).toEqual([]);
    expect(changedTables({...ZERO, chats: 1}, ZERO)).toEqual(['chats 1→0']);
  });
  it('matches journal rows by workflow id', () => {
    const ids = new Set(['w1']);
    expect(journalRowsFor([{workflowId: 'w1'}, {workflowId: 'w2'}], [{_id: 'w1'}, {_id: 'w3'}], ids)).toEqual({steps: 1, workflows: 1});
    expect(journalRowsFor([{workflowId: 'w2'}], [], ids)).toEqual({steps: 0, workflows: 0});
  });
});
