import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {convexTest} from 'convex-test';
import {ACCOUNT_DELETE_FRESHNESS_MS} from '@praxis/protocol';
import {registerCore, sessionIdentity} from '@convex-dev/auth/test';
import {registerEmail, registerResendStub, sentEmails} from '@convex-dev/auth/components/email/test';
import {registerPassword} from '@convex-dev/auth/components/password/test';
import {registerGoogleOauth} from '@convex-dev/auth/components/google/test';
import {registerAppleOauth} from '@convex-dev/auth/components/apple/test';
import workflowComponent from '@convex-dev/workflow/test';
import schema from '../convex/schema.js';
import {api, components} from '../convex/_generated/api.js';

const modules = import.meta.glob('../convex/**/*.ts');
const SERVER_TOKEN = 'credential-test-server-token-longer-than-32-characters';
const PASSWORD = 'correct horse mango battery zebra';
const WRONG_PASSWORD = 'incorrect horse mango battery zebra';
const EMAIL = 'erase@example.test';
const GOOGLE_SUB = 'google-subject-1';
const APPLE_SUB = 'apple-subject-1';
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
  registerAppleOauth(t);
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
    await ctx.runMutation(components.authApple.provider._internal_dangerous_createAccount, {
      providerAccountId: APPLE_SUB, userId,
    });
  });
}

function credentials(t: CredentialTest, userId: string) {
  return t.run(async ctx => ({
    google: await ctx.runQuery(components.authGoogle.provider.getUserIdByAccount, {providerAccountId: GOOGLE_SUB}),
    apple: await ctx.runQuery(components.authApple.provider.getUserIdByAccount, {providerAccountId: APPLE_SUB}),
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
    vi.unstubAllEnvs();
  });

  it('requires fresh authentication, fences both sessions, and lets only the confirming session resume deletion', async () => {
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
    expect(await owner.mutation(api.account.confirmDeletion, {})).toEqual(confirmed);
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
    await t.mutation(api.account.begin, begin);
    expect(await owner.query(api.auth.currentUser, {})).toBeNull();
    expect(await otherSession.query(api.account.deletionOwner, {})).toBeNull();
    expect(await otherSession.mutation(api.auth.refreshSession, {refreshToken: second.tokens.refreshToken})).toEqual({kind: 'noSession'});
    expect(await owner.query(api.account.deletionOwner, {})).toEqual({userId, pending: true});
    expect(await owner.mutation(api.account.confirmDeletion, {})).toEqual(confirmed);

    await t.mutation(api.account.begin, begin);
    const result = await t.mutation(api.account.purge, begin);
    expect(result).toEqual({done: true});
    expect(await owner.query(api.account.deletionOwner, {})).toBeNull();
    expect(await owner.mutation(api.auth.refreshSession, {refreshToken: tokens.refreshToken})).toEqual({kind: 'noSession'});
  }, PASSWORD_REAUTH_TEST_TIMEOUT_MS);

  it('removes password, OAuth, email and session rows, then lets the same email sign up cleanly', async () => {
    const t = setup();
    const tokens = await signUp(t);
    const userId = tokens.userId;
    await linkOAuth(t, userId);
    expect(await verifyPassword(t, userId, PASSWORD)).toEqual({success: true});
    expect(await credentials(t, userId)).toMatchObject({google: userId, apple: userId, emails: [{email: EMAIL}]});

    await deleteAccount(t, userId);

    expect(await t.run(ctx => ctx.db.query('users').collect())).toEqual([]);
    expect(await credentials(t, userId)).toEqual({google: null, apple: null, emails: [], sessions: []});
    await expect(verifyPassword(t, userId, PASSWORD)).rejects.toThrow('No password stored');
    expect(await t.mutation(api.auth.refreshSession, {refreshToken: tokens.refreshToken})).toEqual({kind: 'noSession'});
    const oldSignIn = await t.mutation(api.auth.signInWithEmailPassword, {email: EMAIL, password: PASSWORD});
    expect(oldSignIn.status).toBe('error');

    const fresh = await signUp(t);
    expect(fresh.userId).not.toBe(userId);
    await linkOAuth(t, fresh.userId);
    expect(await credentials(t, fresh.userId)).toMatchObject({google: fresh.userId, apple: fresh.userId});
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
        await ctx.runMutation(components.authApple.provider.deleteUser, {userId: 'user-a'});
      }
    });
    expect(await credentials(t, 'user-a')).toMatchObject({google: null, apple: null});
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
