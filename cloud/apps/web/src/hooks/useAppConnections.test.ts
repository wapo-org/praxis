import type { ComposioConnectionStatus } from '@praxis/protocol';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Doc } from '../../../../convex/_generated/dataModel';
import { connectionsFrom } from './useAppConnections';

vi.mock('convex/react', () => ({ useQueries: () => ({}) }));
vi.mock('../../../../convex/_generated/api', () => ({ api: { composio: { connections: { list: 'composio/connections:list' } } } }));

afterEach(() => vi.restoreAllMocks());

describe('connectionsFrom', () => {
  it('parses the same statuses the Convex connections table stores', () => {
    expectTypeOf<Doc<'connections'>['status']>().toEqualTypeOf<ComposioConnectionStatus>();
  });

  it('maps parsed rows by toolkit and drops the fields clients do not use', () => {
    const result = connectionsFrom([
      { _id: 'r1', toolkit: 'gmail', status: 'connected', redirectUrl: 'https://x', connectedAccountId: 'ca_1' },
      { _id: 'r2', toolkit: 'slack', status: 'failed' },
    ]);
    expect(result).toEqual({ state: 'ready', byToolkit: new Map([['gmail', 'connected'], ['slack', 'failed']]) });
  });

  it('is loading until the query answers, and an error when it threw', () => {
    expect(connectionsFrom(undefined)).toEqual({ state: 'loading' });
    expect(connectionsFrom(new Error('Account unavailable'))).toEqual({ state: 'error' });
  });

  it.each([
    ['an unknown status', [{ toolkit: 'gmail', status: 'needs_reauth' }]],
    ['a non-string toolkit', [{ toolkit: 42, status: 'connected' }]],
    ['an empty toolkit', [{ toolkit: '', status: 'connected' }]],
    ['a non-array result', { toolkit: 'gmail', status: 'connected' }],
  ])('fails closed for the whole result on %s', (_case, result) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const valid = { toolkit: 'slack', status: 'connected' };
    expect(connectionsFrom(Array.isArray(result) ? [valid, ...result] : result)).toEqual({ state: 'error' });
    expect(warn).toHaveBeenCalledOnce();
  });
});
