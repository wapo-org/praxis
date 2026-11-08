import { createClerkClient, verifyToken } from '@clerk/backend';
import type { User } from '@praxis/protocol';
import type { ConvexRPC } from './convex.js';

export interface ClerkIdentity { id: string; email: string; verified: boolean; name: string }
export interface ClerkBackend {
  verify(token: string): Promise<{ sub: string; sid: string; exp: number; authTime: number }>;
  user(id: string): Promise<ClerkIdentity>;
  deleteUser(id: string): Promise<void>;
}
export function realClerk(env: Record<string, string | undefined>, origins: string[]): ClerkBackend {
  if (!env.CLERK_JWT_KEY || !env.CLERK_SECRET_KEY || !env.CLERK_PUBLISHABLE_KEY) throw Error('Clerk keys are required');
  const client = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return {
    async verify(token) {
      const jwt = await verifyToken(token, { jwtKey: env.CLERK_JWT_KEY!, authorizedParties: origins });
      if (!jwt.sid || !jwt.sub || !origins.includes(String(jwt.azp))) throw Error('Invalid session');
      // fva is Clerk's age (minutes) of the first/second factor. JWT iat refreshes every minute and is NOT reauthentication.
      const age = Array.isArray(jwt.fva) ? Number(jwt.fva[0]) : NaN;
      return { sub: jwt.sub, sid: jwt.sid, exp: jwt.exp, authTime: Number.isFinite(age) && age >= 0 ? Date.now() - age * 60000 : 0 };
    },
    async user(id) {
      const user = await client.users.getUser(id);
      const email = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
      return { id, email: email?.emailAddress ?? '', verified: email?.verification?.status === 'verified', name: user.fullName ?? user.username ?? email?.emailAddress ?? 'Praxis user' };
    },
    async deleteUser(id) {
      try { await client.users.deleteUser(id); }
      catch (error) { if (!(typeof error === 'object' && error && 'status' in error && error.status === 404)) throw error; }
    },
  };
}
export function clerkAuth(backend: ClerkBackend, rpc: ConvexRPC, ownership?: { activate(id: string): Promise<void>; isActive(id: string): Promise<boolean> }) {
  async function identity(request: Request) {
    const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    let jwt;
    try { jwt = await backend.verify(token); } catch { return null; }
    if (jwt.exp * 1000 <= Date.now()) return null;
    const where = [{ field: 'providerId', value: 'clerk' }, { field: 'accountId', value: jwt.sub }];
    let binding = await rpc.query('auth:read', { operation: 'findOne', input: { model: 'account', where } }) as { userId: string } | null;
    if (!binding) {
      let profile: ClerkIdentity;
      try { profile = await backend.user(jwt.sub); }
      catch (error) { if (typeof error === 'object' && error && 'status' in error && error.status === 404) return null; throw error; }
      if (!profile.verified || !profile.email) return null;
      binding = await rpc.mutation('authClerk:resolve', { identity: profile }) as { userId: string };
    }
    const user = await rpc.query('auth:read', { operation: 'findOne', input: { model: 'user', where: [{ field: 'id', value: binding.userId }] } }) as { id: string; name: string; email: string; deleting?: boolean } | null;
    if (!user || user.deleting) return null;
    if (ownership && !await ownership.isActive(user.id)) await ownership.activate(user.id);
    return { user: { type: 'user', id: user.id, name: user.name, email: user.email } as User, expiresAt: new Date(jwt.exp * 1000).toISOString(), jwt };
  }
  return {
    async resolveSession(request: Request) { const s = await identity(request); return s && { user: s.user, expiresAt: s.expiresAt }; },
    async confirmDeletion(request: Request) {
      const s = await identity(request);
      return s && Date.now() - s.jwt.authTime >= 0 && Date.now() - s.jwt.authTime < 300000 ? { userId: s.user.id, sessionId: s.jwt.sid } : null;
    },
    async deleteExternal(userId: string) {
      const binding = await rpc.query('auth:read', { operation: 'findOne', input: { model: 'account', where: [{ field: 'providerId', value: 'clerk' }, { field: 'userId', value: userId }] } }) as { accountId: string } | null;
      if (binding) await backend.deleteUser(binding.accountId);
    },
    async handler(_request: Request) { return Response.json({ type: 'error', code: 'clerk_required', message: 'Use Clerk to manage your session' }, { status: 410 }); },
  };
}
