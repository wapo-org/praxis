import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_EMAIL_METHOD_CONFLICT } from '@praxis/protocol';
import { ConvexError } from 'convex/values';
import { convexTest } from 'convex-test';
import { registerCore, sessionIdentity } from '@convex-dev/auth/test';
import { registerEmail, registerResendStub, sentEmails } from '@convex-dev/auth/components/email/test';
import { registerPassword } from '@convex-dev/auth/components/password/test';
import schema from '../convex/schema.js';
import { api, internal } from '../convex/_generated/api.js';
import { authError } from '../apps/web/src/auth/constants.js';

const modules = import.meta.glob('../convex/**/*.ts');
const PASSWORD = 'correct horse mango battery zebra';
const EMAIL = 'alice@example.test';
beforeEach(() => {
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  vi.stubEnv('SITE_URL', 'https://app.example.test');
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  vi.stubEnv('SENDER_EMAIL', 'auth@example.test');
  vi.stubEnv('SENDER_NAME', 'Praxis');
});
function setup() {
  const t = convexTest(schema, modules);
  registerCore(t);
  registerEmail(t);
  registerPassword(t);
  registerResendStub(t);
  return t.withRequestMetadata({ ip: '127.0.0.1' });
}
async function emailCode(t: ReturnType<typeof setup>) {
  const emails = await sentEmails(t);
  const url = emails.at(-1)?.text?.match(/https:\/\/\S+/)?.[0];
  if (!url) throw new Error('No validation email captured');
  return new URL(url).searchParams.get('code')!;
}
async function signup(t: ReturnType<typeof setup>) {
  const start = await t.mutation(api.auth.signUpWithEmailPassword, { email: EMAIL, password: PASSWORD });
  expect(start.success).toBe(true);
  if (!start.success) throw new Error('Sign-up failed');
  return { browserSecret: start.browserSecret, emailCode: await emailCode(t) };
}
describe('Convex Auth v2', () => {
  it('verifies email, signs in, recovers password, rotates sessions, and signs out', async () => {
    const t = setup();
    expect(await t.query(api.auth.currentUser, {})).toBeNull();
    const proof = await signup(t);
    expect((await t.mutation(api.auth.signInWithEmailPassword, { email: EMAIL, password: PASSWORD })).status).toBe('error');
    const complete = await t.mutation(api.auth.completeSignUpWithEmailPassword, proof);
    expect(complete.status).toBe('complete');
    if (complete.status !== 'complete') throw new Error('Verification failed');
    expect(await t.withIdentity(sessionIdentity(complete.tokens)).query(api.auth.currentUser, {})).toBe(complete.tokens.userId);
    expect((await t.mutation(api.auth.completeSignUpWithEmailPassword, proof)).status).toBe('error');
    expect((await t.mutation(api.auth.signInWithEmailPassword, { email: EMAIL, password: PASSWORD })).status).toBe('complete');
    const recovery = await t.mutation(api.auth.startPasswordRecovery, { email: EMAIL });
    if (!recovery.success) throw new Error('Recovery failed');
    const resetProof = { browserSecret: recovery.browserSecret, emailCode: await emailCode(t) };
    expect(await t.query(api.auth.checkPasswordRecovery, resetProof)).toEqual({ success: true });
    const reset = await t.mutation(api.auth.completePasswordRecovery, { ...resetProof, newPassword: PASSWORD + 'new' });
    if (reset.status !== 'complete') throw new Error('Reset failed');
    expect((await t.mutation(api.auth.signInWithEmailPassword, { email: EMAIL, password: PASSWORD })).status).toBe('error');
    const refreshed = await t.mutation(api.auth.refreshSession, { refreshToken: reset.tokens.refreshToken });
    expect(refreshed.kind).toBe('rotated');
    await t.mutation(api.auth.signOut, { refreshToken: reset.tokens.refreshToken });
    expect(await t.mutation(api.auth.refreshSession, { refreshToken: reset.tokens.refreshToken })).toEqual({ kind: 'noSession' });
  });
  it('rejects invalid proofs and package-invalid passwords', async () => {
    const t = setup();
    const bad = await t.mutation(api.auth.signUpWithEmailPassword, { email: EMAIL, password: 'tiny' });
    expect(bad).toMatchObject({ success: false, userError: { error: 'PASSWORD_TOO_SHORT' } });
    const proof = await signup(t);
    expect(await t.mutation(api.auth.completeSignUpWithEmailPassword, { ...proof, browserSecret: 'wrong' })).toMatchObject({ status: 'error' });
  });
  it('rejects OAuth email collisions instead of silently making another identity', async () => {
    const t = setup();
    const proof = await signup(t);
    await t.mutation(api.auth.completeSignUpWithEmailPassword, proof);
    await expect(t.mutation(internal.users.createUserGoogle, { method: {
      name: 'google', profile: { id: 'google-alice', email: EMAIL, emailVerified: true },
    } })).rejects.toThrow(AUTH_EMAIL_METHOD_CONFLICT);
    const rows = await t.run(ctx => ctx.db.query('users').collect());
    expect(rows).toHaveLength(1);
  });
  it('rejects password verification for an email already owned by OAuth', async () => {
    const t = setup();
    await t.mutation(internal.users.createUserGoogle, { method: {
      name: 'google', profile: { id: 'google-alice', email: EMAIL, emailVerified: true },
    } });
    const proof = await signup(t);
    await expect(t.mutation(api.auth.completeSignUpWithEmailPassword, proof)).rejects.toThrow(AUTH_EMAIL_METHOD_CONFLICT);
  });
  it('shows retry delays, browser binding and expired-link guidance', () => {
    expect(authError({ error: 'RATE_LIMITED', retryAfterMs: 1501 })).toContain('2 seconds');
    expect(authError({ error: 'MISSING_SECRET' })).toContain('browser');
    expect(authError({ error: 'INVALID_CHALLENGE' })).toContain('Start again');
    expect(authError({ error: 'OTHER_ERROR', cause: new ConvexError(AUTH_EMAIL_METHOD_CONFLICT) })).toContain('original sign-in');
    expect(authError({ error: 'UNRECOGNIZED' })).toContain('try again');
  });
});
