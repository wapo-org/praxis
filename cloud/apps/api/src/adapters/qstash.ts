import {Client, Receiver} from '@upstash/qstash';
import {z} from 'zod';
import type {ContinuationScheduler} from '../execution.js';

/** Continuation carries only runId; never include secrets or transcripts. */
export const ContinuationMessageSchema = z.object({type: z.literal('run.continue'), userId: z.string().min(1).max(500), runId: z.string().min(1).max(500)}).strict();
export type ContinuationMessage = z.infer<typeof ContinuationMessageSchema>;

export class ContinuationAuthError extends Error {}

/** Publishes next slice to QStash for signed at-least-once callback delivery. */
export function createQStashScheduler(options: {token?: string; callbackUrl: string; client?: Pick<Client, 'publishJSON'>}): ContinuationScheduler {
  const callbackUrl = z.string().url().parse(options.callbackUrl);
  const client = options.client ?? new Client({token: z.string().min(1).parse(options.token)});
  return {
    async schedule(userId, runId) {
      const body: ContinuationMessage = {type: 'run.continue', userId, runId};
      await client.publishJSON({url: callbackUrl, body, retries: 3});
    },
  };
}

/** Verify QStash JWT (sub = callbackUrl, SHA-256 of raw body) before parsing body. */
export function createQStashVerifier(options: {currentSigningKey: string; nextSigningKey: string; callbackUrl: string}) {
  const receiver = new Receiver({currentSigningKey: z.string().min(1).parse(options.currentSigningKey), nextSigningKey: z.string().min(1).parse(options.nextSigningKey)});
  return async (request: Request): Promise<ContinuationMessage> => {
    const signature = request.headers.get('upstash-signature');
    if (!signature) throw new ContinuationAuthError('Missing signature');
    const body = await request.text();
    if (body.length > 10_000) throw new ContinuationAuthError('Body too large');
    const ok = await receiver.verify({signature, body, url: options.callbackUrl, clockTolerance: 5}).catch(() => false);
    if (!ok) throw new ContinuationAuthError('Invalid signature');
    return ContinuationMessageSchema.parse(JSON.parse(body));
  };
}
