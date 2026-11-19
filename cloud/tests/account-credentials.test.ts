import type {Redis} from '@upstash/redis';
import {createFunctionHandle} from 'convex/server';
import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {convexTest} from 'convex-test';
import {
  ACCOUNT_DELETE_FRESHNESS_MS,
  INTERNAL_CONTINUATION_PATH,
} from '@praxis/protocol';
import {registerCore, sessionIdentity} from '@convex-dev/auth/test';
import {registerEmail, registerResendStub, sentEmails} from '@convex-dev/auth/components/email/test';
import {registerPassword} from '@convex-dev/auth/components/password/test';
import {registerGoogleOauth} from '@convex-dev/auth/components/google/test';
import workflowComponent from '@convex-dev/workflow/test';
import {createProductionApp} from '../apps/api/src/production.js';
import * as upstash from '../apps/api/src/adapters/upstash.js';
import {fakeRedis} from '../apps/api/src/adapters/testing/fake-redis.js';
import schema from '../convex/schema.js';
import {api, components, internal} from '../convex/_generated/api.js';

const modules = import.meta.glob('../convex/**/*.ts');
const SERVER_TOKEN = 'credential-test-server-token-longer-than-32-characters';
const PASSWORD = 'correct horse mango battery zebra';
const WRONG_PASSWORD = 'incorrect horse mango battery zebra';
const EMAIL = 'erase@example.test';
const API_ORIGIN = 'https://api.example.test';
const TEST_ACCESS_TTL_SECONDS = 600;
const TEST_SESSION_TTL_SECONDS = 3600;
const GOOGLE_SUB = 'google-subject-1';
const PURGE_CALLS_MAX = 20;
const PINNED_AUTH_VERSION = '2.0.0';
// Matches the component's verifyPassword token bucket capacity.
const VERIFY_ATTEMPTS_MAX = 5;
const PASSWORD_REAUTH_TEST_TIMEOUT_MS = 20_000;
type PurgeResult = {done: boolean; blobCursor?: string; blobsDone?: boolean};

function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerEmail(t);
  registerPassword(t);
  registerResendStub(t);
  registerGoogleOauth(t);
  workflowComponent.register(t);
  return Object.assign(t.withRequestMetadata({ip: '127.0.0.1'}), {registerComponent: t.registerComponent.bind(t)});
}
type CredentialTest = ReturnType<typeof setup>;

async function emailCode(t: CredentialTest) {
  const url = (await sentEmails(t)).at(-1)?.text?.match(/https:\/\/\S+/)?.[0];
  if (!url) throw new Error('No validation email captured');
  return new URL(url).searchParams.get('code')!;
}

async function signUp(t: CredentialTest) {
  const start = await t.mutation(api.auth.signUpWithEmailPassword, {email: EMAIL, password: PASSWORD});
  if (!start.success) throw new Error('Sign-up failed');
  const complete = await t.mutation(api.auth.completeSignUpWithEmailPassword, {
    browserSecret: start.browserSecret, emailCode: await emailCode(t),
  });
  if (complete.status !== 'complete') throw new Error('Verification failed');
  return complete.tokens;
}

function linkOAuth(t: CredentialTest, userId: string) {
  return t.run(async ctx => {
    await ctx.runMutation(components.authGoogle.provider._internal_dangerous_createAccount, {
      providerAccountId: GOOGLE_SUB, userId,
    });
  });
}

function credentials(t: CredentialTest, userId: string) {
  return t.run(async ctx => ({
    google: await ctx.runQuery(components.authGoogle.provider.getUserIdByAccount, {providerAccountId: GOOGLE_SUB}),
    emails: await ctx.runQuery(components.authEmail.verifiedEmails.getEmails, {userId}),
    sessions: await ctx.runQuery(components.auth.public.listSessions, {userId}),
  }));
}

function verifyPassword(t: CredentialTest, userId: string, password: string) {
  return t.run(ctx => ctx.runMutation(components.authPassword.public.verifyPassword, {userId, password}));
}

async function deleteAccount(t: CredentialTest, userId: string) {
  await t.mutation(api.account.begin, {serverToken: SERVER_TOKEN, userId});
  let result: PurgeResult = {done: false};
  for (let call = 0; !result.done && call < PURGE_CALLS_MAX; call++) {
    result = await t.mutation(api.account.purge, {
      serverToken: SERVER_TOKEN, userId, blobCursor: result.blobCursor, blobsDone: result.blobsDone,
    });
  }
  expect(result.done).toBe(true);
}

describe('account deletion erases auth credentials', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('SITE_URL', 'https://app.example.test');
    vi.stubEnv('RESEND_API_KEY', 'test-only');
    vi.stubEnv('SENDER_EMAIL', 'auth@example.test');
    vi.stubEnv('SENDER_NAME', 'Praxis');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('requires the current password even for a fresh session and revokes all sessions by the final batch', async () => {
    const t = setup();
    const tokens = await signUp(t);
    const userId = tokens.userId;
    const identity = sessionIdentity(tokens);
    const owner = t.withIdentity(identity);
    const second = await t.mutation(api.auth.signInWithEmailPassword, {email: EMAIL, password: PASSWORD});
    if (second.status !== 'complete') throw new Error('Second sign-in failed');
    const otherSession = t.withIdentity(sessionIdentity(second.tokens));

    const confirmed = { userId, sessionId: identity.subject };
    expect(await t.query(api.account.deletionOwner, {})).toBeNull();
    expect(await owner.mutation(api.account.confirmDeletion, {})).toBeNull();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ACCOUNT_DELETE_FRESHNESS_MS + 1);
    try {
      expect(await owner.mutation(api.account.confirmDeletion, {})).toBeNull();
      expect(await owner.mutation(api.account.confirmDeletion, {password: WRONG_PASSWORD})).toBeNull();
      expect(await owner.mutation(api.account.confirmDeletion, {password: PASSWORD})).toEqual(confirmed);
    } finally {
      clock.mockRestore();
    }

    const begin = {serverToken: SERVER_TOKEN, userId, keepSessionId: identity.subject};
    vi.useFakeTimers();
    await t.mutation(api.account.begin, begin);
    expect(await owner.query(api.auth.currentUser, {})).toBeNull();
    expect(await otherSession.query(api.account.deletionOwner, {})).toBeNull();
    expect(await otherSession.mutation(api.account.confirmDeletion, {password: PASSWORD})).toBeNull();
    await expect(t.mutation(api.account.begin, {...begin, keepSessionId: sessionIdentity(second.tokens).subject}))
      .rejects.toThrow('Account deletion session unavailable');
    await expect(t.mutation(api.auth.signInWithEmailPassword, {email: EMAIL, password: PASSWORD}))
      .rejects.toThrow('Account unavailable');
    expect(await otherSession.mutation(api.auth.refreshSession, {refreshToken: second.tokens.refreshToken})).toEqual({kind: 'noSession'});
    expect(await owner.query(api.account.deletionOwner, {})).toEqual({userId, pending: true});
    expect(await owner.mutation(api.account.confirmDeletion, {})).toEqual(confirmed);

    await t.mutation(api.account.begin, begin);
    const result = await t.mutation(api.account.purge, {serverToken: SERVER_TOKEN, userId});
    expect(result).toEqual({done: true});
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await owner.query(api.account.deletionOwner, {})).toBeNull();
    expect(await owner.mutation(api.auth.refreshSession, {refreshToken: tokens.refreshToken})).toEqual({kind: 'noSession'});
  }, PASSWORD_REAUTH_TEST_TIMEOUT_MS);

  it('resumes a committed purge through a fresh API after sign-out and preserves sibling owner data', async () => {
    const t = setup();
    const profile = {id: GOOGLE_SUB, email: EMAIL, emailVerified: true};
    const userId = await t.mutation(internal.users.createUserGoogle, {method: {name: 'google', profile}});
    await t.run(ctx => ctx.runMutation(components.authGoogle.provider._internal_dangerous_createAccount, {
      userId, providerAccountId: GOOGLE_SUB,
    }));
    const signIn = () => t.run(async ctx => ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
      claims: {method: 'google', profile},
      userId, componentPath: 'authGoogle',
      onSignInHandle: await createFunctionHandle(internal.users.onGoogleSignIn),
      accessTokenTtlSeconds: TEST_ACCESS_TTL_SECONDS,
      refreshInactivityTimeoutSeconds: TEST_SESSION_TTL_SECONDS,
      sessionMaxLifetimeSeconds: TEST_SESSION_TTL_SECONDS,
    }));
    const tokens = await signIn();
    const identity = sessionIdentity(tokens);
    const owner = t.withIdentity(identity);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + ACCOUNT_DELETE_FRESHNESS_MS);
    expect(await owner.mutation(api.account.confirmDeletion, {})).toBeNull();
    const fresh = await signIn();
    const freshIdentity = sessionIdentity(fresh);
    const confirmingClient = t.withIdentity(freshIdentity);
    expect(await confirmingClient.mutation(api.account.confirmDeletion, {}))
      .toEqual({userId, sessionId: freshIdentity.subject});

    const siblingId = await t.mutation(internal.users.createUserGoogle, {
      method: {name: 'google', profile: {...profile, id: 'sibling-subject', email: 'sibling@example.test'}},
    });
    const {ownerStateId, siblingState} = await t.run(async ctx => {
      await ctx.db.insert('sequences', {userId, value: 1});
      const state = {kind: 'tool', id: 'shared-id'};
      const ownerStateId = await ctx.db.insert('toolState', {...state, userId, value: {name: 'owner'}});
      const siblingStateId = await ctx.db.insert('toolState', {...state, userId: siblingId, value: {name: 'sibling'}});
      return {ownerStateId, siblingState: await ctx.db.get(siblingStateId)};
    });
    const server = {serverToken: SERVER_TOKEN, userId};
    await expect(t.mutation(api.account.begin, {...server, userId: siblingId, keepSessionId: freshIdentity.subject}))
      .rejects.toThrow('Account deletion session unavailable');
    await expect(t.mutation(api.account.purge, {...server, userId: siblingId}))
      .rejects.toThrow('Account deletion has not begun');
    expect(await t.query(api.account.pending, {...server, userId: siblingId})).toBe(false);
    expect(await t.run(ctx => ctx.db.query('toolState').collect())).toHaveLength(2);

    await t.mutation(api.account.begin, {...server, keepSessionId: freshIdentity.subject});
    expect(await owner.mutation(api.auth.refreshSession, {refreshToken: tokens.refreshToken})).toEqual({kind: 'noSession'});
    expect(await t.mutation(api.account.purge, server)).toEqual({done: false});
    expect(await t.run(ctx => ctx.db.query('sequences').collect())).toEqual([]);
    expect(await t.run(ctx => ctx.db.get(ownerStateId))).not.toBeNull();
    await expect(signIn()).rejects.toThrow('Account unavailable');
    await confirmingClient.mutation(api.auth.signOut, {refreshToken: fresh.refreshToken});
    expect(await confirmingClient.query(api.account.deletionOwner, {})).toBeNull();
    expect((await credentials(t, userId)).sessions).toEqual([]);
    expect(await t.query(api.account.pending, server)).toBe(true);

    vi.stubEnv('PRAXIS_API_URL', API_ORIGIN);
    const config = {
      PRAXIS_API_URL: API_ORIGIN,
      PRAXIS_WEB_ORIGINS: 'https://app.example.test',
      PRAXIS_TURN_CURRENT_SIGNING_KEY: 't'.repeat(32),
      PRAXIS_ENCRYPTION_KEYS: Buffer.alloc(32, 1).toString('base64'),
      CONVEX_URL: 'https://test.convex.cloud',
      PRAXIS_CONVEX_SERVER_TOKEN: SERVER_TOKEN,
      UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'test-redis-token',
      QSTASH_TOKEN: 'test-qstash-token',
      QSTASH_CURRENT_SIGNING_KEY: 'test-current-signing-key',
      QSTASH_NEXT_SIGNING_KEY: 'test-next-signing-key',
    };
    const memory = fakeRedis();
    const redisFactory = vi.spyOn(upstash, 'createUpstashAdapters').mockImplementation(() => ({
      redis: memory.redis as Redis,
      ...upstash.upstashFromRedis(memory.redis, {accountOwnership: true}),
    }));
    let interrupted: {
      result: PurgeResult;
      rowRemoved: boolean;
      pending: boolean;
      active: boolean;
      googleOwner: string | null;
    } | undefined;
    const deliveryStatuses: number[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.href === API_ORIGIN + INTERNAL_CONTINUATION_PATH) {
        const request = new Request(url, init);
        expect(request.headers.has('authorization')).toBe(false);
        const response = await createProductionApp(config).app.fetch(request);
        deliveryStatuses.push(response.status);
        return response;
      }
      expect(url.origin).toBe(config.CONVEX_URL);
      const {path, args: [args]} = JSON.parse(String(init?.body));
      if (url.pathname === '/api/query' && path === 'account:pending') {
        return Response.json({status: 'success', value: await t.query(api.account.pending, args)});
      }
      if (url.pathname === '/api/mutation' && path === 'account:purge') {
        expect(args).toEqual(server);
        const value = await t.mutation(api.account.purge, args);
        if (!interrupted) {
          interrupted = {
            result: value,
            rowRemoved: (await t.run(ctx => ctx.db.get(ownerStateId))) === null,
            pending: await t.query(api.account.pending, server),
            active: await t.query(api.account.active, server),
            googleOwner: (await credentials(t, userId)).google,
          };
          return new Response(null, {status: 503});
        }
        return Response.json({status: 'success', value});
      }
      throw new Error(`Unexpected Convex request: ${url.pathname} ${path}`);
    }));

    try {
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    } finally {
      redisFactory.mockRestore();
    }
    expect(interrupted).toEqual({
      result: {done: false}, rowRemoved: true, pending: true, active: false, googleOwner: userId,
    });
    expect(deliveryStatuses[0]).toBe(500);
    expect(deliveryStatuses.at(-1)).toBe(200);
    expect(siblingState).not.toBeNull();
    expect(await t.run(ctx => ctx.db.query('toolState').collect())).toEqual([siblingState]);
    expect(await t.query(api.account.pending, server)).toBe(false);
    expect(await credentials(t, userId)).toEqual({google: null, emails: [], sessions: []});
    expect(await t.run(async ctx => (await ctx.db.query('users').collect()).map(user => user._id))).toEqual([siblingId]);
    expect(await t.run(async ctx => (await ctx.db.query('oauthEmails').collect()).map(email => email.userId))).toEqual([siblingId]);
    expect(await t.mutation(api.auth.refreshSession, {refreshToken: fresh.refreshToken}))
      .toEqual({kind: 'noSession'});
  });

  it('removes password, OAuth, email and session rows, then lets the same email sign up cleanly', async () => {
    const t = setup();
    const tokens = await signUp(t);
    const userId = tokens.userId;
    await linkOAuth(t, userId);
    expect(await verifyPassword(t, userId, PASSWORD)).toEqual({success: true});
    expect(await credentials(t, userId)).toMatchObject({google: userId, emails: [{email: EMAIL}]});

    await deleteAccount(t, userId);

    expect(await t.run(ctx => ctx.db.query('users').collect())).toEqual([]);
    expect(await credentials(t, userId)).toEqual({google: null, emails: [], sessions: []});
    await expect(verifyPassword(t, userId, PASSWORD)).rejects.toThrow('No password stored');
    expect(await t.mutation(api.auth.refreshSession, {refreshToken: tokens.refreshToken})).toEqual({kind: 'noSession'});
    const oldSignIn = await t.mutation(api.auth.signInWithEmailPassword, {email: EMAIL, password: PASSWORD});
    expect(oldSignIn.status).toBe('error');

    const fresh = await signUp(t);
    expect(fresh.userId).not.toBe(userId);
    await linkOAuth(t, fresh.userId);
    expect(await credentials(t, fresh.userId)).toMatchObject({google: fresh.userId});
  });
});

describe('patched @convex-dev/auth component deletes', () => {
  it('password deleteUser is idempotent, scoped to one user, and resets the verify throttle', async () => {
    const t = setup();
    const set = (userId: string) => t.run(ctx => ctx.runMutation(
      components.authPassword.public._internal_dangerous_setPassword, {userId, password: PASSWORD, minimumLength: 8},
    ));
    await set('user-a');
    await set('user-b');
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS_MAX; attempt++) await verifyPassword(t, 'user-a', WRONG_PASSWORD);
    expect(await verifyPassword(t, 'user-a', PASSWORD)).toMatchObject({userError: {error: 'RATE_LIMITED'}});

    const erase = () => t.run(ctx => ctx.runMutation(components.authPassword.public.deleteUser, {userId: 'user-a'}));
    expect(await erase()).toBeNull();
    expect(await erase()).toBeNull();
    await expect(verifyPassword(t, 'user-a', PASSWORD)).rejects.toThrow('No password stored');
    expect(await verifyPassword(t, 'user-b', PASSWORD)).toEqual({success: true});
    await set('user-a');
    expect(await verifyPassword(t, 'user-a', PASSWORD)).toEqual({success: true});
  });

  it('OAuth deleteUser removes only that user\'s accounts in each provider component', async () => {
    const t = setup();
    await linkOAuth(t, 'user-a');
    await t.run(ctx => ctx.runMutation(components.authGoogle.provider._internal_dangerous_createAccount, {
      providerAccountId: 'google-subject-2', userId: 'user-b',
    }));
    await t.run(async ctx => {
      for (let call = 0; call < 2; call++) {
        await ctx.runMutation(components.authGoogle.provider.deleteUser, {userId: 'user-a'});
      }
    });
    expect(await credentials(t, 'user-a')).toMatchObject({google: null});
    const other = await t.run(ctx => ctx.runQuery(components.authGoogle.provider.getUserIdByAccount, {
      providerAccountId: 'google-subject-2',
    }));
    expect(other).toBe('user-b');
  });

  it('pins the exact package version the checked-in patch was made against', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.dependencies['@convex-dev/auth']).toBe(PINNED_AUTH_VERSION);
    expect(pkg.scripts.postinstall).toContain('patch-package --error-on-fail');
    expect(pkg.scripts.preverify).toContain('patch-package --error-on-fail');
    const patch = await readFile(new URL(`../patches/@convex-dev+auth+${PINNED_AUTH_VERSION}.patch`, import.meta.url), 'utf8');
    expect(patch).toContain('Praxis patch (PRA-64)');
  });
});
