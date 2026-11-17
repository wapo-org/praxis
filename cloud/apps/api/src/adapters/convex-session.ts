import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';

const currentUser = makeFunctionReference<'query', Record<string, never>, string | null>('auth:currentUser');
class InvalidSession extends Error {}

export async function verifiedConvexOwner(request: Request, url: string) {
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
    return z.string().min(1).nullable().parse(await client.query(currentUser, {}));
  } catch (error) {
    if (error instanceof InvalidSession) return null;
    throw error;
  }
}
