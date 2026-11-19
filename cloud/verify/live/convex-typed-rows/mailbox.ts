import {setTimeout as sleep} from 'node:timers/promises';
import {SealedSecret} from '@praxis/types';
import {z} from 'zod';

/** Convex Auth sends the sign-up link through the app's mounted Resend component, which keeps each email's body. */
const RESEND_COMPONENT = 'resend';
const EMAIL_SCAN_ROWS_MAX = 50;
const EMAIL_POLL_MS = 1_000;
const EMAIL_WAIT_MS = 30_000;
const ADMIN_REQUEST_TIMEOUT_MS = 20_000;

const AdminReply = z.discriminatedUnion('status', [
  z.object({status: z.literal('success'), value: z.unknown()}),
  z.object({status: z.literal('error'), errorMessage: z.string()}),
]);
const EmailRows = z.object({
  page: z.array(z.object({_id: z.string(), to: z.union([z.string(), z.array(z.string())])})),
});
const EmailBody = z.object({text: z.string().optional(), html: z.string().optional()}).nullable();

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
  return list.some(address => address.toLowerCase().includes(wanted));
}

async function adminQuery(convexUrl: string, deployKey: SealedSecret, path: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(new URL('/api/query', convexUrl), {
    method: 'POST',
    headers: {authorization: `Convex ${deployKey.reveal()}`, 'content-type': 'application/json'},
    body: JSON.stringify({componentPath: RESEND_COMPONENT, path, format: 'convex_encoded_json', args}),
    signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Convex admin query ${path} answered HTTP ${response.status}`);
  const reply = AdminReply.parse(await response.json());
  if (reply.status === 'error') throw new Error(`Convex admin query ${path} failed`);
  return reply.value;
}

async function latestEmailId(convexUrl: string, deployKey: SealedSecret, email: string): Promise<string | null> {
  const rows = EmailRows.parse(await adminQuery(convexUrl, deployKey, '_system/cli/tableData:default', {
    table: 'emails', order: 'desc', paginationOpts: {cursor: null, numItems: EMAIL_SCAN_ROWS_MAX},
  }));
  return rows.page.find(row => isRecipient(row.to, email))?._id ?? null;
}

/** Reads the one-time sign-up code with the deployment admin key; the code never leaves a `SealedSecret`. */
export async function readSignUpCode(convexUrl: string, deployKey: SealedSecret, email: string): Promise<SealedSecret> {
  const deadline = Date.now() + EMAIL_WAIT_MS;
  for (;;) {
    const emailId = await latestEmailId(convexUrl, deployKey, email);
    if (emailId) {
      const body = EmailBody.parse(await adminQuery(convexUrl, deployKey, 'lib:get', {emailId}));
      const code = emailCodeFrom(body?.text ?? '') ?? emailCodeFrom(body?.html ?? '');
      if (code) return SealedSecret.of(code);
    }
    if (Date.now() >= deadline) throw new Error('No sign-up email with a code reached the deployment mailbox');
    await sleep(EMAIL_POLL_MS);
  }
}
