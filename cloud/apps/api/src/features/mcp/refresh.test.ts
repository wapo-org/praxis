import {describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import type {Connector} from '@praxis/protocol';
import {featureContext} from '../../features.js';
import {createLocalAdapters} from '../../local-memory.js';
import {ApiService} from '../../service.js';
import {withClient} from './client.js';
import {connector, writeSecret} from './shared.js';

async function setup(error: string, status = 400) {
  let refreshes = 0, mcpCalls = 0;
  const ctx = featureContext(new ApiService(createLocalAdapters(), true), 'u', {
    encryptionKey: randomBytes(32).toString('base64'),
    fetch: async input => {
      if (String(input).endsWith('/token')) { refreshes++; return Response.json({error}, {status}); }
      mcpCalls++;
      throw new Error('MCP must not be contacted when refresh fails');
    },
  });
  const value: Connector = {type: 'connector', id: 'c', name: 'C', url: 'http://localhost:7777/mcp', transport: 'streamableHttp', enabled: true, trusted: false, disabledTools: [], authStatus: 'connected', updatedAt: new Date().toISOString()};
  await ctx.store.put('u', 'connector', value.id, value);
  for (const [slot, data] of Object.entries({
    tokens: {access_token: 'old', token_type: 'Bearer', refresh_token: 'revoked', expires_in: 1},
    tokenSavedAt: '2020-01-01T00:00:00Z', client: {client_id: 'id'},
    discovery: {authorizationServerUrl: 'http://localhost:7777', resource: value.url, metadata: {issuer: 'http://localhost:7777', token_endpoint: 'http://localhost:7777/token', authorization_endpoint: 'http://localhost:7777/auth', response_types_supported: ['code']}},
  })) await writeSecret(ctx, value.id, slot, data);
  return {ctx, value, counts: () => ({refreshes, mcpCalls})};
}

describe('REV-A2 refresh failure is never anonymous MCP', () => {
  it('marks revoked refresh needs_reauth through authStatus=required and stops later calls', async () => {
    const f = await setup('invalid_grant');
    for (let n = 0; n < 2; n++) await expect(withClient(f.ctx, f.value, {}, async () => 'wrong')).rejects.toMatchObject({status: 409, code: 'authorization_required'});
    expect(await connector(f.ctx, f.value.id)).toMatchObject({authStatus: 'required', error: 'needs_reauth'});
    expect(f.counts()).toEqual({refreshes: 1, mcpCalls: 0});
  });
  it('transient refresh failure stops MCP without destroying the connected state', async () => {
    const f = await setup('server_error', 503);
    await expect(withClient(f.ctx, f.value, {}, async () => 'wrong')).rejects.toMatchObject({status: 502, code: 'token_refresh_failed'});
    expect((await connector(f.ctx, f.value.id)).authStatus).toBe('connected');
    expect(f.counts()).toEqual({refreshes: 1, mcpCalls: 0});
  });
});


it('lease contention remains a retryable refresh failure and never marks needs_reauth or calls MCP', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  try {
    const f = await setup('invalid_grant');
    const work = withClient(f.ctx, f.value, {lease: {acquire: async () => null, release: async () => {}}}, async () => 'wrong');
    const rejected = expect(work).rejects.toMatchObject({status: 502, code: 'token_refresh_busy'});
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect((await connector(f.ctx, f.value.id)).authStatus).toBe('connected');
    expect(f.counts()).toEqual({refreshes: 0, mcpCalls: 0});
  } finally { vi.useRealTimers(); }
});
