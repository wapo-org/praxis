import { describe, it, expect, vi } from 'vitest';
import { clerkAuth, type ClerkBackend } from './auth-clerk.js';
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
    expect((await f.auth.resolveSession(f.request))?.user.id).toBe('legacy');
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
  it('requires recent factor authentication for deletion', async () => {
    const f = fixture();
    expect(await f.auth.confirmDeletion(f.request)).toMatchObject({ userId: 'clerk-1' });
    vi.mocked(f.backend.verify).mockResolvedValue({ sub: 'clerk-1', sid: 'session-1', exp: Date.now()/1000 + 60, authTime: Date.now() - 600000 });
    expect(await f.auth.confirmDeletion(f.request)).toBeNull();
  });
});
