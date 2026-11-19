import {SealedSecret} from '@praxis/types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {beginFencesOwner, changedTables, journalRowsFor, nonEmptyTables, ownerRowCount, sequenceProblems, type RowCounts} from './commit-purge.js';
import {liveOwnerSession} from './owners.js';

const ZERO: RowCounts = {chats: 0, messages: 0, runs: 0, turns: 0, sandboxes: 0, outputs: 0};

afterEach(() => vi.unstubAllGlobals());

it('renews the fixture and checks the distinct client and server deletion errors', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const {path} = JSON.parse(String(init.body));
    calls.push(path);
    if (path === 'auth:refreshSession') {
      const tokens = {userId: 'fixture', accessToken: 'renewed', refreshToken: 'rotated'};
      return Response.json({status: 'success', value: {kind: 'rotated', tokens}});
    }
    if (path === 'account:begin') return Response.json({status: 'success', value: null});
    const client = new Headers(init.headers).get('Authorization') === 'Bearer renewed';
    const errorData = client ? 'Authentication required' : 'Account unavailable';
    return Response.json({status: 'error', errorData, errorMessage: errorData});
  });
  const convexUrl = 'https://fixture.convex.cloud';
  const owner = liveOwnerSession(convexUrl, 'fixture@example.test', {
    userId: 'fixture', accessToken: 'original', refreshToken: 'refresh',
  });
  const live = {convexUrl, serverToken: SealedSecret.of('fixture-server-token')};
  const result = await beginFencesOwner(live, owner, 'fixture-chat');
  expect(result.status).toBe('pass');
  expect(calls).toEqual([
    'auth:refreshSession', 'account:begin', 'chats:list', 'messages:page',
    'chats:create', 'messages:commit', 'store:put',
  ]);
});

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
