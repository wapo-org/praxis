import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { componentsGeneric } from 'convex/server';
import { registerCore, sessionIdentity } from '@convex-dev/auth/test';
import { registerEmail } from '@convex-dev/auth/components/email/test';
import { registerPassword } from '@convex-dev/auth/components/password/test';
import { registerGoogleOauth } from '@convex-dev/auth/components/google/test';
import { registerAppleOauth } from '@convex-dev/auth/components/apple/test';
import { AccountDeleteSchema } from '@praxis/protocol';
import workflowComponent from '@convex-dev/workflow/test';
import { api, components } from '../convex/_generated/api.js';
import { AUTH_ENV } from '../convex/authConstants.js';
import schema from '../convex/schema.js';
import type { internal as googleInternal } from '../node_modules/@convex-dev/auth/src/components/google/_generated/api.js';
import type { internal as appleInternal } from '../node_modules/@convex-dev/auth/src/components/apple/_generated/api.js';
import { sha256Hex } from '../node_modules/@convex-dev/auth/src/lib/crypto.js';
import { encryptTicketPayload, generateRandomToken } from '../node_modules/@convex-dev/auth/src/lib/oauth/crypto.js';

const modules = import.meta.glob('../convex/**/*.ts');
const SERVER_TOKEN = 'oauth-deletion-test-server-token-longer-than-32-characters';
const PURGE_CALLS_MAX = 20;

// Ticket creation is internal to the pinned OAuth components.
const callbacks = componentsGeneric() as unknown as {
  authGoogle: { provider: Pick<typeof googleInternal.provider, 'createTicket'> };
  authApple: { provider: Pick<typeof appleInternal.provider, 'createTicket'> };
};

const providers = [
  {
    name: 'Google',
    claims: { sub: 'google-delete-subject', email: 'delete-google@example.test', email_verified: true },
    mint: callbacks.authGoogle.provider.createTicket,
    complete: api.auth.completeSignInWithGoogle,
    lookup: components.authGoogle.provider.getUserIdByAccount,
  },
  {
    name: 'Apple',
    claims: { sub: 'apple-delete-subject', email: 'delete-apple@example.test', email_verified: 'true' },
    mint: callbacks.authApple.provider.createTicket,
    complete: api.auth.completeSignInWithApple,
    lookup: components.authApple.provider.getUserIdByAccount,
  },
] as const;

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerEmail(t);
  registerPassword(t);
  registerGoogleOauth(t);
  registerAppleOauth(t);
  workflowComponent.register(t);
  return t.withRequestMetadata({ ip: '127.0.0.1' });
}

async function signIn(t: ReturnType<typeof setup>, provider: (typeof providers)[number]) {
  // Start at the callback's ticket boundary so redemption uses the real provider component and callbacks.
  const code = generateRandomToken();
  const state = generateRandomToken();
  await t.mutation(provider.mint, {
    stateHash: await sha256Hex(state),
    ticketCodeHash: await sha256Hex(code),
    encryptedPayload: await encryptTicketPayload(code, JSON.stringify({ claims: provider.claims })),
  });
  const result = await t.mutation(provider.complete, { code, state });
  expect(result.status).toBe('complete');
  if (result.status !== 'complete') throw new Error(`${provider.name} ticket did not redeem`);
  return result.tokens;
}

describe('OAuth account deletion', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv(AUTH_ENV.siteUrl, 'https://app.example.test');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(providers)('$name revokes both sessions and creates a clean account for the same identity', async provider => {
    const t = setup();
    const first = await signIn(t, provider);
    const confirming = await signIn(t, provider);
    const { userId } = first;
    const firstIdentity = sessionIdentity(first);
    const confirmingIdentity = sessionIdentity(confirming);
    const firstSession = t.withIdentity(firstIdentity);
    const confirmingSession = t.withIdentity(confirmingIdentity);
    const lookup = () => t.query(provider.lookup, { providerAccountId: provider.claims.sub });
    const oauthEmails = () => t.run(async ctx => {
      const rows = await ctx.db.query('oauthEmails').collect();
      return rows.map(({ userId, email }) => ({ userId, email }));
    });

    expect(confirming.userId).toBe(userId);
    expect(confirmingIdentity.subject).not.toBe(firstIdentity.subject);
    expect(await firstSession.query(api.auth.currentUser, {})).toBe(userId);
    expect(await lookup()).toBe(userId);
    expect(await oauthEmails()).toEqual([{ userId, email: provider.claims.email }]);

    const confirmation = await confirmingSession.mutation(api.account.confirmDeletion, AccountDeleteSchema.parse({}));
    expect(confirmation).toEqual({ userId, sessionId: confirmingIdentity.subject });
    if (!confirmation) throw new Error('Fresh OAuth session could not confirm deletion');
    const deletion = { serverToken: SERVER_TOKEN, userId: confirmation.userId, keepSessionId: confirmation.sessionId };
    await t.mutation(api.account.begin, deletion);
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: first.refreshToken })).toEqual({ kind: 'noSession' });
    expect(await confirmingSession.query(api.account.deletionOwner, {})).toEqual({ userId, pending: true });

    let done = false;
    for (let call = 0; !done && call < PURGE_CALLS_MAX; call++) {
      ({ done } = await t.mutation(api.account.purge, deletion));
    }
    expect(done).toBe(true);
    expect(await lookup()).toBeNull();
    expect(await oauthEmails()).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('users').collect())).toEqual([]);

    const fresh = await signIn(t, provider);
    expect(fresh.userId).not.toBe(userId);
    expect(await lookup()).toBe(fresh.userId);
    expect(await oauthEmails()).toEqual([{ userId: fresh.userId, email: provider.claims.email }]);
    expect(await t.withIdentity(sessionIdentity(fresh)).query(api.auth.currentUser, {})).toBe(fresh.userId);
    expect((await t.mutation(api.auth.refreshSession, { refreshToken: fresh.refreshToken })).kind).toBe('rotated');

    for (const old of [first, confirming]) {
      expect(await t.withIdentity(sessionIdentity(old)).query(api.auth.isAuthenticated, {})).toBe(false);
      expect(await t.mutation(api.auth.refreshSession, { refreshToken: old.refreshToken })).toEqual({ kind: 'noSession' });
    }
  });
});
