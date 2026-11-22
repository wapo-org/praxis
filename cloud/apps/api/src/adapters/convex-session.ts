import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ACCOUNT_DELETE_PATH } from '@praxis/protocol';

const currentUser = makeFunctionReference<'query', Record<string, never>, string | null>('auth:currentUser');
class InvalidSession extends Error {}

const deletionOwner = makeFunctionReference<'query'>('account:deletionOwner');
const confirmDeletion = makeFunctionReference<'mutation'>('account:confirmDeletion');
const deletionOwnerSchema = z.object({ userId: z.string().min(1), pending: z.boolean() }).nullable();
const confirmationSchema = z.object({ userId: z.string().min(1), sessionId: z.string().min(1) }).nullable();

export function isAccountDeletion(request: Request) {
  return request.method === 'DELETE' && new URL(request.url).pathname === ACCOUNT_DELETE_PATH;
}

export async function verifiedConvexOwner(request: Request, url: string) {
  return withConvexSession(request, url, async client => {
    if (isAccountDeletion(request)) {
      return deletionOwnerSchema.parse(await client.query(deletionOwner, {}))?.userId ?? null;
    }
    return z.string().min(1).nullable().parse(await client.query(currentUser, {}));
  });
}

export async function confirmConvexDeletion(request: Request, url: string, password?: string) {
  return withConvexSession(request, url, async client => {
    const args = password === undefined ? {} : { password };
    return confirmationSchema.parse(await client.mutation(confirmDeletion, args));
  });
}

async function withConvexSession<T>(request: Request, url: string, call: (client: ConvexHttpClient) => Promise<T>) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return null;
  const client = new ConvexHttpClient(url, {
    logger: false,
    auth: token,
    fetch: async (input, init) => {
      const response = await fetch(input, { ...init, redirect: 'error' });
      if (response.status === 401) throw new InvalidSession();
      return response;
    },
  });
  try {
    return await call(client);
  } catch (error) {
    if (error instanceof InvalidSession) return null;
    throw error;
  }
}
