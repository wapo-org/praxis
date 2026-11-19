import { SealedSecret } from '@praxis/types';
import { internal } from '../_generated/api.js';
import { httpAction } from '../functions.js';
import { COMPOSIO_WEBHOOK_SECRET_ENV, WEBHOOK_BODY_BYTES_MAX } from './constants.js';
import { verifyComposioWebhook, type WebhookRejection } from './webhook.js';

const REJECTION_STATUS: Record<WebhookRejection, number> = {
  missing_secret: 503,
  missing_headers: 401,
  too_large: 413,
  stale_timestamp: 401,
  bad_signature: 401,
  bad_payload: 400,
};

function json(status: number, body: Record<string, string | boolean>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const composioWebhook = httpAction(async (ctx, request) => {
  const rawSecret = process.env[COMPOSIO_WEBHOOK_SECRET_ENV];
  if (!rawSecret) return json(503, { error: 'webhook_unconfigured' });
  if (Number(request.headers.get('content-length') ?? 0) > WEBHOOK_BODY_BYTES_MAX) {
    return json(413, { error: 'too_large' });
  }
  const verification = await verifyComposioWebhook({
    headers: request.headers,
    rawBody: await request.text(),
    secret: SealedSecret.of(rawSecret),
    nowMs: Date.now(),
  });
  if (!verification.ok) {
    return json(REJECTION_STATUS[verification.reason], { error: verification.reason });
  }
  const { event } = verification;
  if (event.kind === 'ignored') return json(200, { ok: true, applied: false });
  // Unknown or already-settled accounts still get 200: retrying cannot change the outcome.
  const applied: boolean = await ctx.runMutation(internal.composio.connections.markFromWebhook, {
    connectedAccountId: event.connectedAccountId,
    status: event.status,
  });
  return json(200, { ok: true, applied });
});
