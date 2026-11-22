import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { loadEnv, envArg } from './deploy-config.mjs';

/** Private bindings for the consenting, pre-provisioned hosted smoke account; values are never printed. */
export const SMOKE_FIXTURE_KEYS = [
  'SMOKE_API_ORIGIN',
  'SMOKE_CONVEX_URL',
  'SMOKE_FIXTURE_EMAIL',
  'SMOKE_FIXTURE_PASSWORD',
  'SMOKE_FIXTURE_USER_ID',
];

const SIGN_IN = makeFunctionReference('auth:signInWithEmailPassword');
const SIGN_OUT = makeFunctionReference('auth:signOut');
const REFRESH = makeFunctionReference('auth:refreshSession');

export async function fixtureBindings(args, api) {
  const env = await loadEnv(envArg(args));
  const missing = SMOKE_FIXTURE_KEYS.filter((key) => !env[key]);
  if (missing.length) {
    throw Error(`Hosted smoke needs a consenting fixture account; missing private bindings: ${missing.join(', ')}`);
  }
  const apiOrigin = bareHttpsOrigin(env.SMOKE_API_ORIGIN, 'SMOKE_API_ORIGIN');
  const convexOrigin = bareHttpsOrigin(env.SMOKE_CONVEX_URL, 'SMOKE_CONVEX_URL');
  // Bindings name one isolated target so a fixture password is never replayed against another deployment.
  if (apiOrigin !== api) {
    throw Error('SMOKE_API_ORIGIN does not name this API; refusing to use the fixture elsewhere');
  }
  return { ...env, SMOKE_API_ORIGIN: apiOrigin, SMOKE_CONVEX_URL: convexOrigin };
}

/** Exact match rejects userinfo, paths, queries and fragments (even an empty `?` or `#`); the raw value is never echoed. */
export function bareHttpsOrigin(value, key) {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  if (url?.protocol !== 'https:' || value.replace(/\/$/, '') !== url.origin) {
    throw Error(`${key} must be a bare HTTPS origin`);
  }
  return url.origin;
}

/** Signs the fixture in through the deployment's Convex Auth functions, never through API auth routes. */
export function fixtureSession(env, fetcher) {
  const sessions = [];
  const client = () => new ConvexHttpClient(env.SMOKE_CONVEX_URL, { logger: false, fetch: fetcher });

  async function signIn() {
    let result;
    try {
      result = await client().mutation(SIGN_IN, {
        email: env.SMOKE_FIXTURE_EMAIL,
        password: env.SMOKE_FIXTURE_PASSWORD,
      });
    } catch {
      // Server error text is not ours to print; the stage alone is reported.
      throw Error('Fixture sign-in request failed');
    }
    if (result?.status !== 'complete') {
      throw Error(`Fixture sign-in denied: ${result?.userError?.error ?? 'unexpected response'}`);
    }
    sessions.push(result.tokens);
    if (result.tokens.userId !== env.SMOKE_FIXTURE_USER_ID) {
      const message = 'Fixture sign-in resolved to an unexpected user';
      await signOut().catch((error) => {
        throw Error(`${message}; ${error.message}`);
      });
      throw Error(`${message}; signed out before writing data`);
    }
    return result.tokens.accessToken;
  }

  /** Tries every session; only confirmed revocations are retired, so a retry still holds the rest. */
  async function signOut() {
    const failures = [];
    const remaining = [];
    for (const [index, tokens] of sessions.entries()) {
      const problem = await revoke(tokens);
      if (problem) {
        failures.push(`session ${index + 1}: ${problem}`);
        remaining.push(tokens);
      }
    }
    sessions.splice(0, sessions.length, ...remaining);
    if (failures.length) {
      throw Error(`Fixture sign-out incomplete (${failures.join('; ')}); revoke those sessions manually`);
    }
  }

  // auth:signOut consumes only the refresh token, so a possibly expired access token is never attached.
  async function revoke(tokens) {
    try {
      await client().mutation(SIGN_OUT, { refreshToken: tokens.refreshToken });
    } catch {
      return 'revocation request failed';
    }
    let check;
    try {
      check = await client().mutation(REFRESH, { refreshToken: tokens.refreshToken });
    } catch {
      return 'revocation check failed';
    }
    if (check?.kind === 'noSession') return undefined;
    // A rotation proves the session is live; keep its successor so a later sign-out can still revoke it.
    if (check?.kind === 'rotated') Object.assign(tokens, check.tokens);
    return 'session still live after sign-out';
  }

  return { signIn, signOut, signedIn: () => sessions.length > 0 };
}
