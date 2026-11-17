import { LOCAL_CONVEX_URL_ENV } from '@praxis/protocol';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';

const LOCAL_SESSION_MAX_MS = 60_000;
const LocalUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.username && !url.password;
}, 'Local Convex authentication requires a loopback HTTP origin');
const currentUser = makeFunctionReference<'query', Record<string, never>, string | null>('auth:currentUser');

export function localConvexSession(env: NodeJS.ProcessEnv) {
  const raw = env[LOCAL_CONVEX_URL_ENV];
  if (!raw) return undefined;
  if (env.NODE_ENV === 'production' || env.VERCEL !== undefined) throw new Error('Local Convex authentication is development only');
  const url = LocalUrl.parse(raw);
  return async (request: Request) => {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) return null;
    const client = new ConvexHttpClient(url, { logger: false });
    client.setAuth(authorization.slice('Bearer '.length));
    const id = z.string().min(1).nullable().parse(await client.query(currentUser, {}));
    if (!id) return null;
    return {
      user: { type: 'user' as const, id, name: 'Local developer' },
      expiresAt: new Date(Date.now() + LOCAL_SESSION_MAX_MS).toISOString(),
    };
  };
}
