import { describe, expect, it, vi } from 'vitest';
import { localConvexSession } from './local-convex-auth.js';
import { createLocalAdapters } from './local-memory.js';
import { createPraxisApp } from './server.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    setAuth = vi.fn();
    query = query;
  },
}));
describe('explicit local Convex authentication', () => {
  it('requires a loopback deployment and refuses production', () => {
    expect(localConvexSession({})).toBeUndefined();
    expect(() => localConvexSession({ PRAXIS_LOCAL_CONVEX_URL: 'https://untrusted.example' })).toThrow('loopback');
    expect(() => localConvexSession({ PRAXIS_LOCAL_CONVEX_URL: 'http://127.0.0.1:8861', NODE_ENV: 'production' })).toThrow('development only');
  });
  it('derives the owner from the verified query and never falls back to dev tokens', async () => {
    const resolveSession = localConvexSession({ PRAXIS_LOCAL_CONVEX_URL: 'http://127.0.0.1:8861' })!;
    expect(await resolveSession(new Request('http://local/v1/bootstrap'))).toBeNull();
    query.mockResolvedValueOnce('verified-user');
    const session = await resolveSession(new Request('http://local/v1/bootstrap', {
      headers: { Authorization: 'Bearer fixture-access-token' },
    }));
    expect(session?.user.id).toBe('verified-user');
    const memory = createLocalAdapters();
    const { app } = createPraxisApp({
      adapters: memory, local: true, encryptionKey: Buffer.alloc(32).toString('base64'),
      resolveSession: async () => null,
    });
    const denied = await app.request('/v1/bootstrap', { headers: { Authorization: 'Bearer dev-local' } });
    expect(denied.status).toBe(401);
  });
  it('fails closed when the configured backend is unavailable', async () => {
    query.mockRejectedValueOnce(new Error('Backend unavailable'));
    const resolveSession = localConvexSession({ PRAXIS_LOCAL_CONVEX_URL: 'http://127.0.0.1:8861' })!;
    await expect(resolveSession(new Request('http://local/', { headers: { Authorization: 'Bearer fixture-token' } }))).rejects.toThrow('Backend unavailable');
  });
});
