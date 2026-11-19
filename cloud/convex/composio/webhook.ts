import type { SealedSecret } from '@praxis/types';
import type { Infer } from 'convex/values';
import { z } from 'zod';
import {
  WEBHOOK_BODY_BYTES_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURES_MAX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from './constants.js';
import type { webhookStatus } from './schema.js';

// Signing scheme source: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events

export type WebhookStatus = Infer<typeof webhookStatus>;

export type ComposioEvent =
  | { kind: 'connection'; eventId: string; connectedAccountId: string; status: WebhookStatus }
  | { kind: 'ignored'; eventId: string; type: string };

export type WebhookRejection = 'missing_secret' | 'missing_headers' | 'too_large' | 'stale_timestamp' | 'bad_signature' | 'bad_payload';

export type WebhookVerification =
  | { ok: true; event: ComposioEvent }
  | { ok: false; reason: WebhookRejection };

export type WebhookInput = {
  headers: Pick<Headers, 'get'>;
  rawBody: string;
  secret?: SealedSecret;
  nowMs: number;
};

const CONNECTED_ACCOUNT_ID_MAX = 256;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;

const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.unknown(),
});

/** Only these events carry a connection status; every other event type is acknowledged and ignored. */
const CONNECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'composio.connected_account.activated',
  'composio.connected_account.expired',
]);

const connectionDataSchema = z.object({
  id: z.string().min(1).max(CONNECTED_ACCOUNT_ID_MAX),
  status: z.string(),
});

const CONNECTION_STATUS: ReadonlyMap<string, WebhookStatus> = new Map([
  ['ACTIVE', 'connected'],
  ['FAILED', 'failed'],
  ['EXPIRED', 'failed'],
]);

export async function verifyComposioWebhook(input: WebhookInput): Promise<WebhookVerification> {
  if (!input.secret) return { ok: false, reason: 'missing_secret' };
  const id = input.headers.get(WEBHOOK_ID_HEADER);
  const timestamp = input.headers.get(WEBHOOK_TIMESTAMP_HEADER);
  const signatureHeader = input.headers.get(WEBHOOK_SIGNATURE_HEADER);
  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }
  const encoder = new TextEncoder();
  const body = encoder.encode(input.rawBody);
  if (body.byteLength > WEBHOOK_BODY_BYTES_MAX) {
    return { ok: false, reason: 'too_large' };
  }
  if (!fresh(timestamp, input.nowMs)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const signed = encoder.encode(`${id}.${timestamp}.${input.rawBody}`);
  if (!await anySignatureMatches(input.secret, signed, signatureHeader)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const event = parseEvent(input.rawBody);
  return event ? { ok: true, event } : { ok: false, reason: 'bad_payload' };
}

function fresh(timestamp: string, nowMs: number): boolean {
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  const skewMs = Math.abs(nowMs - Number(timestamp) * 1000);
  return skewMs <= WEBHOOK_TOLERANCE_SECONDS * 1000;
}

async function anySignatureMatches(secret: SealedSecret, signed: Uint8Array<ArrayBuffer>, header: string): Promise<boolean> {
  // Composio keys the HMAC with the secret's UTF-8 bytes, not a base64-decoded Standard Webhooks `whsec_` key.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.reveal()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // `subtle.verify` compares in constant time, so no hand-rolled comparison of the expected signature is needed.
  for (const signature of v1Signatures(header)) {
    if (await crypto.subtle.verify('HMAC', key, signature, signed)) return true;
  }
  return false;
}

function v1Signatures(header: string): Uint8Array<ArrayBuffer>[] {
  const entries = header.split(' ').filter(Boolean).slice(0, WEBHOOK_SIGNATURES_MAX);
  return entries.flatMap(entry => {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') return [];
    const bytes = decodeBase64(entry.slice(comma + 1));
    return bytes ? [bytes] : [];
  });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function parseEvent(rawBody: string): ComposioEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const { id: eventId, type } = envelope.data;
  if (!CONNECTION_EVENT_TYPES.has(type)) return { kind: 'ignored', eventId, type };
  const data = connectionDataSchema.safeParse(envelope.data.data);
  if (!data.success) return null;
  const status = CONNECTION_STATUS.get(data.data.status);
  if (!status) return { kind: 'ignored', eventId, type };
  return { kind: 'connection', eventId, connectedAccountId: data.data.id, status };
}
