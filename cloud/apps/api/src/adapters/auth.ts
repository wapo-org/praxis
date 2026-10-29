import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { createAdapterFactory, type CustomAdapter } from 'better-auth/adapters';
import { AuthInputSchema, SessionSchema, type User } from '@praxis/protocol';
import { z } from 'zod';
import type { KV } from '../contracts.js';
import { createConvexRPC, type ConvexRPC } from './convex.js';

/** What `createApp({authHandler, resolveSession})` takes. */
export interface PraxisAuth {
  handler(request: Request): Promise<Response>;
  resolveSession(request: Request): Promise<{ user: User; expiresAt: string } | null>;
}

export interface AuthOptions {
  /** Public API origin, e.g. https://api.example.com. HTTPS is required except for localhost. */
  baseURL: string;
  /** BETTER_AUTH_SECRET, at least 32 characters. */
  secret: string;
  /** Exact web origins allowed to call auth routes with an Origin header. */
  trustedOrigins: string[];
  /** `none` when the web app and API are on different sites (requires HTTPS). Default `lax`. */
  cookieSameSite?: 'lax' | 'strict' | 'none';
  /** Optional hot session cache; entries never outlive the session and expire within `cacheSeconds`. */
  cache?: KV;
  cacheSeconds?: number;
}

const AuthEnvSchema = z.object({
  CONVEX_URL: z.url(),
  PRAXIS_CONVEX_SERVER_TOKEN: z.string().min(32),
  BETTER_AUTH_SECRET: z.string().min(32),
  PRAXIS_API_URL: z.url(),
  PRAXIS_WEB_ORIGINS: z.string().min(1),
  PRAXIS_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).optional(),
});

/** Production Better Auth on Convex. Throws (fails closed) when configuration is incomplete. */
export function createAuth(env: Record<string, string | undefined>, cache?: KV): PraxisAuth {
  const e = AuthEnvSchema.parse(env);
  const rpc = createConvexRPC({ url: e.CONVEX_URL, serverToken: e.PRAXIS_CONVEX_SERVER_TOKEN });
  return authFromRPC(rpc, {
    baseURL: e.PRAXIS_API_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: parseOrigins(e.PRAXIS_WEB_ORIGINS),
    cookieSameSite: e.PRAXIS_COOKIE_SAMESITE,
    cache,
  });
}

export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const url = new URL(x);
      if (url.origin !== x.replace(/\/$/, '')) throw new Error(`Web origin must be a bare origin: ${x}`);
      return url.origin;
    });
}

/** Better Auth custom adapter forwarding each operation to the server-only Convex functions in convex/auth.ts. */
export function convexAuthDatabase(rpc: ConvexRPC) {
  const call = (operation: string, input: unknown) => {
    const args = { operation, input: JSON.parse(JSON.stringify(input)) };
    return ['findOne', 'findMany', 'count'].includes(operation)
      ? rpc.query('auth:read', args)
      : rpc.mutation('auth:execute', args);
  };
  return createAdapterFactory({
    config: {
      adapterId: 'praxis-convex',
      adapterName: 'Server-only Convex',
      supportsDates: false,
      supportsJSON: true,
      supportsBooleans: true,
      supportsArrays: true,
      transaction: false,
      debugLogs: false,
    },
    adapter: () =>
      ({
        create: (input) => call('create', input),
        findOne: (input) => call('findOne', input),
        findMany: (input) => call('findMany', input),
        update: (input) => call('update', input),
        updateMany: (input) => call('updateMany', input),
        delete: async (input) => {
          await call('delete', input);
        },
        deleteMany: (input) => call('deleteMany', input),
        count: (input) => call('count', input),
        consumeOne: (input) => call('consumeOne', input),
        incrementOne: (input) => call('incrementOne', input),
      }) as CustomAdapter,
  });
}

const CachedSessionSchema = z.object({ user: SessionSchema.shape.user, expiresAt: z.iso.datetime() });

const error = (status: number, code: string, message: string, headers?: Headers) =>
  Response.json({ type: 'error', code, message }, { status, headers });

export function authFromRPC(rpc: ConvexRPC, options: AuthOptions): PraxisAuth {
  z.string().min(32).parse(options.secret);
  const base = new URL(options.baseURL);
  const local = base.hostname === 'localhost' || base.hostname === '127.0.0.1';
  if (base.protocol !== 'https:' && !local) throw new Error('Authentication requires HTTPS');
  const sameSite = options.cookieSameSite ?? 'lax';
  if (sameSite === 'none' && base.protocol !== 'https:') throw new Error('SameSite=None cookies require HTTPS');
  const trusted = new Set(options.trustedOrigins);
  const cacheSeconds = Math.max(1, Math.min(options.cacheSeconds ?? 60, 300));

  const auth = betterAuth({
    database: convexAuthDatabase(rpc),
    baseURL: base.origin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [...trusted],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    plugins: [bearer()],
    advanced: {
      useSecureCookies: base.protocol === 'https:',
      defaultCookieAttributes: { sameSite, httpOnly: true, path: '/' },
    },
    logger: { disabled: true },
  });

  type BetterSession = { user: { id: string; name: string; email: string }; session: { expiresAt: Date | string } };
  const toSession = (s: BetterSession) => ({
    user: { type: 'user' as const, id: s.user.id, name: s.user.name, email: s.user.email },
    expiresAt: new Date(s.session.expiresAt).toISOString(),
  });

  /** The raw credential (bearer or session cookie), hashed: tokens never appear in cache keys. */
  const credentialKey = (headers: Headers) => {
    const bearerValue = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const cookie = headers
      .get('cookie')
      ?.split(';')
      .map((c) => c.trim())
      .filter((c) => /session_token=/.test(c))
      .sort()
      .join(';');
    const raw = bearerValue ? `b:${bearerValue}` : cookie ? `c:${cookie}` : undefined;
    return raw && `session:${createHash('sha256').update(raw).digest('base64url')}`;
  };

  async function resolveSession(request: Request) {
    const key = credentialKey(request.headers);
    if (!key) return null;
    if (options.cache) {
      const hit = CachedSessionSchema.safeParse(await options.cache.get(key));
      if (hit.success && Date.parse(hit.data.expiresAt) > Date.now()) return hit.data;
    }
    const session = (await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    })) as BetterSession | null;
    if (!session) return null;
    const result = toSession(session);
    const ttl = Math.min(cacheSeconds, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000));
    if (options.cache && ttl >= 1) await options.cache.set(key, result, ttl);
    return result;
  }

  async function handler(request: Request): Promise<Response> {
    const operation = new URL(request.url).pathname.split('/').at(-1) ?? '';
    if (!['sign-in', 'sign-up', 'sign-out'].includes(operation)) {
      return error(404, 'not_found', 'Auth route not found');
    }
    if (request.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST');
    // Native clients send no Origin; browsers must come from an allowlisted web origin (login CSRF).
    const origin = request.headers.get('origin');
    if (origin !== null && !trusted.has(origin)) return error(403, 'origin_rejected', 'Origin is not allowed');

    let body = '{}';
    if (operation !== 'sign-out') {
      let json: unknown;
      try {
        json = await request.json();
      } catch {
        return error(400, 'invalid_json', 'Expected a JSON request body');
      }
      const input = AuthInputSchema.safeParse(json);
      if (!input.success) return error(400, 'validation_error', 'Request does not match the protocol');
      const { email, password, name } = input.data;
      body = JSON.stringify(
        operation === 'sign-up' ? { email, password, name: name ?? email.split('@')[0] } : { email, password },
      );
    }

    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    const path = `/api/auth/${operation}${operation === 'sign-out' ? '' : '/email'}`;
    const response = await auth.handler(new Request(new URL(path, base), { method: 'POST', headers, body }));
    if (operation === 'sign-out') {
      // After revocation in Convex, so a concurrent resolve cannot re-cache a revoked session.
      const key = credentialKey(request.headers);
      if (key && options.cache) await options.cache.del(key);
    }

    const outgoing = new Headers();
    for (const cookie of response.headers.getSetCookie()) outgoing.append('set-cookie', cookie);
    outgoing.set('cache-control', 'no-store');
    if (!response.ok) {
      const status = response.status >= 500 ? 502 : response.status;
      return error(status, 'auth_failed', 'Authentication failed', outgoing);
    }
    if (operation === 'sign-out') return Response.json({ type: 'ok' }, { headers: outgoing });

    const data = (await response.json()) as { token?: string };
    const token = response.headers.get('set-auth-token') ?? data.token;
    if (!token) return error(502, 'auth_failed', 'Authentication did not produce a session', outgoing);
    const session = (await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
      query: { disableCookieCache: true },
    })) as BetterSession | null;
    if (!session) return error(502, 'auth_failed', 'Authentication session could not be verified', outgoing);
    const dto = SessionSchema.parse({ type: 'session', ...toSession(session), bearerToken: token });
    return Response.json(dto, { status: operation === 'sign-up' ? 201 : 200, headers: outgoing });
  }

  return { handler, resolveSession };
}
