import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {SealedSecret} from '@praxis/types';
import {z} from 'zod';
import type {TableReader} from './commit-purge.js';

/** Convex Auth sends the sign-up link through the app's mounted Resend component, which keeps each email's body. */
const RESEND_COMPONENT = 'resend';
const EMAIL_POLL_MS = 1_000;
const EMAIL_WAIT_MS = 30_000;
const ADMIN_REQUEST_TIMEOUT_MS = 20_000;

const AdminReply = z.discriminatedUnion('status', [
  z.object({status: z.literal('success'), value: z.unknown()}),
  z.object({status: z.literal('error'), errorMessage: z.string()}),
]);
const Recipient = z.union([z.string(), z.array(z.string())]);
const EmailRow = z.object({_id: z.string(), to: Recipient});
const EmailBody = z.object({to: Recipient, text: z.string().optional(), html: z.string().optional()}).nullable();
const SignUpChallenge = z.object({
  email: z.string(),
  browserSecretHash: z.string(),
  purpose: z.object({kind: z.literal('signUp'), userId: z.string()}),
});

/** Pulls the `code` query parameter out of the first link in an email body that carries one. */
export function emailCodeFrom(body: string): string | null {
  const decoded = body.replaceAll('&amp;', '&');
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    try {
      const code = new URL(match[0]).searchParams.get('code');
      if (code) return code;
    } catch {
      continue;
    }
  }
  return null;
}

/** Recipient fields compare case-insensitively, as Convex Auth normalizes addresses. */
export function isRecipient(to: string | readonly string[], email: string): boolean {
  const wanted = email.toLowerCase();
  const list = typeof to === 'string' ? [to] : to;
  return list.some(address => {
    const mailbox = /<([^<>]+)>$/.exec(address.trim())?.[1] ?? address;
    return mailbox.trim().toLowerCase() === wanted;
  });
}

async function adminQuery(convexUrl: string, deployKey: SealedSecret, path: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(new URL('/api/function', convexUrl), {
    method: 'POST',
    headers: {authorization: `Convex ${deployKey.reveal()}`, 'content-type': 'application/json'},
    body: JSON.stringify({componentPath: RESEND_COMPONENT, path, format: 'convex_encoded_json', args}),
    redirect: 'error',
    signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Convex admin query ${path} answered HTTP ${response.status}`);
  const reply = AdminReply.parse(await response.json());
  if (reply.status === 'error') throw new Error(`Convex admin query ${path} failed`);
  return reply.value;
}

export async function signUpOwnerId(reader: TableReader, email: string, browserSecret: SealedSecret): Promise<string> {
  const hash = createHash('sha256').update(browserSecret.reveal()).digest('hex');
  for (const row of await reader('challenges', 'authEmail')) {
    const challenge = SignUpChallenge.safeParse(row).data;
    if (challenge?.email === email && challenge.browserSecretHash === hash) {
      return challenge.purpose.userId;
    }
  }
  throw new Error('Could not identify the disposable owner for cleanup');
}

/** Reads the one-time sign-up code with the deployment admin key; the code never leaves a `SealedSecret`. */
export async function readSignUpCode(convexUrl: string, deployKey: SealedSecret, reader: TableReader, email: string): Promise<SealedSecret> {
  const deadline = Date.now() + EMAIL_WAIT_MS;
  for (;;) {
    for (const row of await reader('emails', RESEND_COMPONENT)) {
      const mail = EmailRow.parse(row);
      if (!isRecipient(mail.to, email)) continue;
      const body = EmailBody.parse(await adminQuery(convexUrl, deployKey, 'lib:get', {emailId: mail._id}));
      if (!body || !isRecipient(body.to, email)) continue;
      const code = emailCodeFrom(body.text ?? '') ?? emailCodeFrom(body.html ?? '');
      if (code) return SealedSecret.of(code);
    }
    if (Date.now() >= deadline) throw new Error('No sign-up email with a code reached the deployment mailbox');
    await sleep(EMAIL_POLL_MS);
  }
}
