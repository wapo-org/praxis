import { describe, it, expect, vi } from 'vitest';
import { clerkAuth, type ClerkBackend } from './auth-clerk.js';
import { storeFromRPC } from './convex.js';
import { convexHarness } from './testing/convex-harness.js';
function fixture() {
  const { rpc } = convexHarness();
  const backend: ClerkBackend = {
    verify: vi.fn(async () => ({ sub: 'clerk-1', sid: 'session-1', exp: Math.floor(Date.now() / 1000) + 60, authTime: Date.now() })),
    user: vi.fn(async () => ({ id: 'clerk-1', email: 'LEGACY@example.test', verified: true, name: 'Name' })),
    deleteUser: vi.fn(async () => {}),
  };
  return { rpc, backend, auth: clerkAuth(backend, rpc), request: new Request('https://api.test/v1/auth/session', { headers: { authorization: 'Bearer fake' } }) };
}
describe('Clerk account binding', () => {
  it('retains legacy id and binds once for a verified same-email login', async () => {
    const f = fixture();
    await f.rpc.mutation('auth:execute', { operation: 'create', input: { model: 'user', data: { id: 'legacy', email: 'legacy@example.test', name: 'Legacy' } } });
    const store = storeFromRPC(f.rpc);
    await store.put('legacy', 'chat', 'kept-chat', { title: 'Keep my history' });
    expect((await f.auth.resolveSession(f.request))?.user.id).toBe('legacy');
    expect((await store.get('legacy', 'chat', 'kept-chat'))?.value.title).toBe('Keep my history');
    expect((await f.auth.resolveSession(f.request))?.user.id).toBe('legacy');
    expect(f.backend.user).toHaveBeenCalledTimes(1);
    await f.auth.deleteExternal('legacy');
    expect(f.backend.deleteUser).toHaveBeenCalledWith('clerk-1');
  });
  it('rejects invalid signatures, unverified email and deleting identities', async () => {
    const f = fixture();
    vi.mocked(f.backend.verify).mockRejectedValueOnce(Error('bad signature'));
    expect(await f.auth.resolveSession(f.request)).toBeNull();
    vi.mocked(f.backend.user).mockResolvedValueOnce({ id: 'clerk-1', email: 'legacy@example.test', verified: false, name: 'Name' });
    expect(await f.auth.resolveSession(f.request)).toBeNull();
    await f.auth.resolveSession(f.request);
    await f.rpc.mutation('auth:execute', { operation: 'update', input: { model: 'user', where: [{ field: 'id', value: 'clerk-1' }], update: { deleting: true } } });
    expect(await f.auth.resolveSession(f.request)).toBeNull();
  });
  it('returns unauthorized for a deleted Clerk subject instead of recreating it', async () => {
    const f = fixture();
    vi.mocked(f.backend.user).mockRejectedValue(Object.assign(Error('deleted'), {status:404}));
    expect(await f.auth.resolveSession(f.request)).toBeNull();
  });
  it('requires recent factor authentication for deletion', async () => {
    const f = fixture();
    expect(await f.auth.confirmDeletion(f.request)).toMatchObject({ userId: 'clerk-1' });
    vi.mocked(f.backend.verify).mockResolvedValue({ sub: 'clerk-1', sid: 'session-1', exp: Date.now()/1000 + 60, authTime: Date.now() - 600000 });
    expect(await f.auth.confirmDeletion(f.request)).toBeNull();
  });
});

it('verifies JWT signatures and origins with the local public key and no JWKS calls', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { realClerk } = await import('./auth-clerk.js');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const backend = realClerk({ CLERK_PUBLISHABLE_KEY: 'pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk', CLERK_SECRET_KEY: 'sk_test_fake', CLERK_JWT_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, ['https://app.test']);
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('network forbidden'));
  try {
    const token = (azp: string, exp = Math.floor(Date.now()/1000)+60) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ sub: 'user_test', sid: 'sess_test', iss: 'https://fake.clerk.accounts.dev', azp, exp, nbf: Math.floor(Date.now()/1000)-5, iat: Math.floor(Date.now()/1000), fva: [0,-1] })).toString('base64url');
      const input = `${header}.${body}`;
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}`;
    };
    expect((await backend.verify(token('https://app.test'))).sub).toBe('user_test');
    await expect(backend.verify(token('https://evil.test'))).rejects.toBeDefined();
    await expect(backend.verify(token('https://app.test', 1))).rejects.toBeDefined();
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
