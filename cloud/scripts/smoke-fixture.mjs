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
const IS_AUTHENTICATED = makeFunctionReference('auth:isAuthenticated');

export async function fixtureBindings(args, api) {
  const env = await loadEnv(envArg(args));
  const missing = SMOKE_FIXTURE_KEYS.filter((key) => !env[key]);
  if (missing.length) {
    throw Error(`Hosted smoke needs a consenting fixture account; missing private bindings: ${missing.join(', ')}`);
  }
  // Bindings name one isolated target so a fixture password is never replayed against another deployment.
  if (originOf(env.SMOKE_API_ORIGIN, 'SMOKE_API_ORIGIN') !== api) {
    throw Error('SMOKE_API_ORIGIN does not name this API; refusing to use the fixture elsewhere');
  }
  if (new URL(originOf(env.SMOKE_CONVEX_URL, 'SMOKE_CONVEX_URL')).protocol !== 'https:') {
    throw Error('SMOKE_CONVEX_URL must be an HTTPS origin');
  }
  return env;
}

function originOf(value, key) {
  try {
    return new URL(value).origin;
  } catch (error) {
    throw Error(`${key} must be a bare origin`, { cause: error });
  }
}

/** Signs the fixture in through the deployment's Convex Auth functions, never through API auth routes. */
export function fixtureSession(env, fetcher) {
  const sessions = [];
  const client = (accessToken) => {
    const convex = new ConvexHttpClient(env.SMOKE_CONVEX_URL, { logger: false, fetch: fetcher });
    if (accessToken) convex.setAuth(accessToken);
    return convex;
  };

  async function signIn() {
    const result = await client().mutation(SIGN_IN, {
      email: env.SMOKE_FIXTURE_EMAIL,
      password: env.SMOKE_FIXTURE_PASSWORD,
    });
    if (result?.status !== 'complete') {
      throw Error(`Fixture sign-in denied: ${result?.userError?.error ?? 'unexpected response'}`);
    }
    sessions.push(result.tokens);
    if (result.tokens.userId !== env.SMOKE_FIXTURE_USER_ID) {
      const message = 'Fixture sign-in resolved to an unexpected user';
      await signOut().catch((error) => {
        throw Error(`${message}; sign-out also failed, revoke that session manually`, { cause: error });
      });
      throw Error(`${message}; signed out before writing data`);
    }
    return result.tokens.accessToken;
  }

  async function signOut() {
    for (const tokens of sessions.splice(0)) {
      await client(tokens.accessToken).mutation(SIGN_OUT, { refreshToken: tokens.refreshToken });
      if ((await client(tokens.accessToken).query(IS_AUTHENTICATED, {})) !== false) {
        throw Error('Fixture session still authenticated after sign-out');
      }
    }
  }

  return { signIn, signOut, signedIn: () => sessions.length > 0 };
}
