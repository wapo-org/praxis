import {randomBytes} from 'node:crypto';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {SealedSecret} from '@praxis/types';
import {z} from 'zod';
import type {TableReader} from './commit-purge.js';
import {readSignUpCode, signUpOwnerId} from './mailbox.js';

/** Resend's test inbox accepts any `delivered+label` address, so real sends neither bounce nor reach a person. */
const TEST_INBOX_DOMAIN = 'resend.dev';
const OWNER_LABELS = ['a', 'b'] as const;
const PASSWORD_BYTES = 24;

const SignUp = makeFunctionReference<'mutation', {email: string; password: string}, unknown>('auth:signUpWithEmailPassword');
const CompleteSignUp = makeFunctionReference<'mutation', {browserSecret: string; emailCode: string}, unknown>('auth:completeSignUpWithEmailPassword');
const RefreshSession = makeFunctionReference<'mutation', {refreshToken: string}, unknown>('auth:refreshSession');
export const CurrentUser = makeFunctionReference<'query', Record<string, never>, unknown>('auth:currentUser');

const SignUpReply = z.discriminatedUnion('success', [
  z.object({success: z.literal(true), browserSecret: z.string().min(1)}),
  z.object({success: z.literal(false), userError: z.object({error: z.string()})}),
]);
const SessionTokens = z.object({accessToken: z.string().min(1), refreshToken: z.string().min(1), userId: z.string().min(1)});
const CompleteReply = z.discriminatedUnion('status', [
  z.object({status: z.literal('complete'), tokens: SessionTokens}),
  z.object({status: z.literal('error'), userError: z.object({error: z.string()})}),
]);
const RefreshReply = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('rotated'), tokens: SessionTokens}),
  z.object({kind: z.literal('noSession')}),
]);
const Viewer = z.string().min(1).nullable();

export type LiveOwner = {
  email: string;
  userId: string;
  /** Authenticated with the owner's Convex Auth access token. */
  client: ConvexHttpClient;
  /** Lets a step open a second client, the HTTP equivalent of reloading the page. */
  token: SealedSecret;
  refresh(): Promise<void>;
};

export type OwnerAccess = {
  /** Deployment admin key, used only to read the sign-up email the deployment itself sent. */
  deployKey: SealedSecret;
  reader: TableReader;
  runId: string;
  log?: (line: string) => void;
  onOwner: (userId: string) => void;
};

/** Lowercase and short, so the address passes Convex Auth's format check and stays unique per run. */
export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '').toLowerCase();
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

export function liveOwnerEmail(runId: string, label: string): string {
  if (!/^[a-z0-9-]+$/.test(runId) || !/^[a-z]$/.test(label)) throw new Error('run id and label must be lowercase tokens');
  return `delivered+live-pra127-${runId}-${label}@${TEST_INBOX_DOMAIN}`;
}

export function authedClient(convexUrl: string, token: SealedSecret): ConvexHttpClient {
  return new ConvexHttpClient(convexUrl, {logger: false, auth: token.reveal()});
}

export function liveOwnerSession(convexUrl: string, email: string, tokens: z.infer<typeof SessionTokens>): LiveOwner {
  let refreshToken = SealedSecret.of(tokens.refreshToken);
  const token = SealedSecret.of(tokens.accessToken);
  const client = authedClient(convexUrl, token);
  const anonymous = new ConvexHttpClient(convexUrl, {logger: false});
  return {
    email, userId: tokens.userId, client, token,
    async refresh() {
      const reply = RefreshReply.parse(await anonymous.mutation(RefreshSession, {refreshToken: refreshToken.reveal()}));
      if (reply.kind !== 'rotated' || reply.tokens.userId !== this.userId) {
        throw new Error('Convex Auth could not renew the disposable owner session');
      }
      refreshToken = SealedSecret.of(reply.tokens.refreshToken);
      this.token = SealedSecret.of(reply.tokens.accessToken);
      client.setAuth(this.token.reveal());
    },
  };
}

async function signUp(convexUrl: string, email: string, access: OwnerAccess): Promise<LiveOwner> {
  const anonymous = new ConvexHttpClient(convexUrl, {logger: false});
  const password = SealedSecret.of(randomBytes(PASSWORD_BYTES).toString('base64url'));
  const started = SignUpReply.parse(await anonymous.mutation(SignUp, {email, password: password.reveal()}).catch((error: unknown) => {
    throw new Error('Convex Auth sign-up call failed', {cause: error});
  }));
  if (!started.success) throw new Error(`Convex Auth rejected the sign-up: ${started.userError.error}`);
  access.log?.(`sign-up started for ${email}`);
  const browserSecret = SealedSecret.of(started.browserSecret);
  const pendingOwnerId = await signUpOwnerId(access.reader, email, browserSecret);
  access.onOwner(pendingOwnerId);
  const code = await readSignUpCode(convexUrl, access.deployKey, access.reader, email);
  const completed = CompleteReply.parse(await anonymous.mutation(CompleteSignUp, {
    browserSecret: browserSecret.reveal(), emailCode: code.reveal(),
  }));
  if (completed.status === 'error') throw new Error(`Convex Auth rejected the sign-up code: ${completed.userError.error}`);
  if (completed.tokens.userId !== pendingOwnerId) throw new Error('Sign-up returned a different owner');
  const owner = liveOwnerSession(convexUrl, email, completed.tokens);
  const userId = Viewer.parse(await owner.client.query(CurrentUser, {}));
  if (!userId) throw new Error('auth:currentUser returned no owner for a fresh session');
  if (userId !== completed.tokens.userId) throw new Error('auth:currentUser disagrees with the session user');
  access.log?.(`signed in ${email} as an active owner`);
  return owner;
}

/** Signs up exactly two owners through the deployment's own password provider, one after the other. */
export async function createLiveOwners(convexUrl: string, count: 2, access: OwnerAccess): Promise<LiveOwner[]> {
  const owners: LiveOwner[] = [];
  for (const label of OWNER_LABELS.slice(0, count)) {
    owners.push(await signUp(convexUrl, liveOwnerEmail(access.runId, label), access));
  }
  if (owners[0]?.userId === owners[1]?.userId) throw new Error('both sign-ups resolved to one owner');
  return owners;
}
