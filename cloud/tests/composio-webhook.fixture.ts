import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from '../convex/composio/constants.js';

/** Generated per test run; the real secret only exists in the Convex deployment env. */
export const TEST_WEBHOOK_SECRET = `test-${crypto.randomUUID()}`;
export const TEST_NOW_MS = Date.UTC(2026, 10, 19, 12, 0, 0);

export async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export function connectionEvent(type: string, connectedAccountId: string, status: string): string {
  return JSON.stringify({
    id: `msg_${crypto.randomUUID()}`,
    type,
    timestamp: '2026-11-19T12:00:00Z',
    metadata: { project_id: 'proj_test' },
    data: {
      id: connectedAccountId,
      toolkit: { slug: 'github' },
      auth_config: { id: 'ac_test', auth_scheme: 'OAUTH2', is_composio_managed: true, is_disabled: false },
      status,
      status_reason: null,
      is_disabled: false,
    },
  });
}

type SignedHeaders = {
  secret?: string;
  nowMs?: number;
  id?: string;
  signature?: string;
};

export async function signedHeaders(body: string, options: SignedHeaders = {}): Promise<Headers> {
  const id = options.id ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor((options.nowMs ?? TEST_NOW_MS) / 1000));
  const signature = options.signature ?? `v1,${await sign(options.secret ?? TEST_WEBHOOK_SECRET, id, timestamp, body)}`;
  return new Headers({
    'content-type': 'application/json',
    [WEBHOOK_ID_HEADER]: id,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    [WEBHOOK_SIGNATURE_HEADER]: signature,
  });
}
