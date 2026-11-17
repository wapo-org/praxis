import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';

const LatestEmail = makeFunctionReference<'query'>('fixture:latestEmail');
export async function latestEmailLink(): Promise<string> {
  const url = z.url().parse(process.env.PW_CONVEX_URL);
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('The test mailbox is local only');
  const client = new ConvexHttpClient(url, { logger: false });
  const text = z.string().parse(await client.query(LatestEmail, {}));
  const link = text.split('\n').find(line => line.startsWith('http://127.0.0.1:'));
  if (!link) throw new Error('No local verification link was delivered');
  return link;
}
