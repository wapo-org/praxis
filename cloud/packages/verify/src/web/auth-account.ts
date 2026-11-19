import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { reserveAuthChallenge } from './auth-budget.js';

export interface TestAccount {
  email: string;
  password: string;
}
const Signup = makeFunctionReference<'mutation'>('auth:signUpWithEmailPassword');
const Complete = makeFunctionReference<'mutation'>('auth:completeSignUpWithEmailPassword');
const RemoveTestOwner = makeFunctionReference<'mutation', Record<string, never>, null>('fixture:removeTestOwner');
const IsAuthenticated = makeFunctionReference<'query', Record<string, never>, boolean>('auth:isAuthenticated');
const LatestEmail = makeFunctionReference<'query'>('fixture:latestEmail');
const SignedUp = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), browserSecret: z.string() }),
  z.object({ success: z.literal(false), userError: z.object({ error: z.string() }) }),
]);
const Completed = z.object({ status: z.literal('complete') });
export const LocalVerificationOrigin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}, 'Verification auth fixtures require a loopback HTTP origin');

export async function latestEmailLink(url: string, email: string): Promise<string> {
  const client = new ConvexHttpClient(LocalVerificationOrigin.parse(url), { logger: false });
  const text = z.string().parse(await client.query(LatestEmail, { email }));
  const link = text.split('\n').find(line => line.startsWith('http://127.0.0.1:'));
  if (!link) throw new Error('No local verification link was delivered');
  return link;
}

export async function createTestAccount(url: string, budgetDirectory?: string): Promise<TestAccount> {
  const client = new ConvexHttpClient(LocalVerificationOrigin.parse(url), { logger: false });
  const account = { email: `browser-${randomUUID()}@example.test`, password: randomUUID() };
  await reserveAuthChallenge(budgetDirectory);
  const started = SignedUp.parse(await client.mutation(Signup, account).catch(() => {
    throw new Error('Could not submit the local Convex Auth verification signup');
  }));
  if (!started.success) {
    if (started.userError.error === 'RATE_LIMITED') {
      throw new Error('Convex Auth rate-limited verification signup. Start a fresh isolated verification stack.');
    }
    throw new Error('Convex Auth rejected the verification signup');
  }
  try {
    const emailCode = new URL(await latestEmailLink(url, account.email)).searchParams.get('code');
    Completed.parse(await client.mutation(Complete, { browserSecret: started.browserSecret, emailCode }));
  } catch {
    throw new Error('Could not complete the local Convex Auth email challenge');
  }
  return account;
}

export async function seedUnavailableAccount(url: string, token: string): Promise<() => Promise<boolean>> {
  const client = new ConvexHttpClient(LocalVerificationOrigin.parse(url), { logger: false, auth: token });
  await client.mutation(RemoveTestOwner, {});
  return () => client.query(IsAuthenticated, {});
}
