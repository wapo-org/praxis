import { SealedSecret } from '@praxis/types';
import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_BODY_BYTES_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../convex/composio/constants.js';
import { verifyComposioWebhook } from '../convex/composio/webhook.js';
import {
  TEST_NOW_MS,
  TEST_WEBHOOK_SECRET,
  connectionEvent,
  sign,
  signedHeaders,
} from './composio-webhook.fixture.js';

const ACTIVATED = 'composio.connected_account.activated';
const EXPIRED = 'composio.connected_account.expired';

async function verify(body: string, headers: Headers, nowMs = TEST_NOW_MS, secret = TEST_WEBHOOK_SECRET) {
  return verifyComposioWebhook({ headers, rawBody: body, secret: secret ? SealedSecret.of(secret) : undefined, nowMs });
}

describe('verifyComposioWebhook', () => {
  it('accepts a valid activation and maps it to connected', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_valid', 'ACTIVE');
    const result = await verify(body, await signedHeaders(body));
    expect(result).toMatchObject({
      ok: true,
      event: { kind: 'connection', connectedAccountId: 'ca_valid', status: 'connected' },
    });
  });

  it('maps an expired account to failed', async () => {
    const body = connectionEvent(EXPIRED, 'ca_expired', 'EXPIRED');
    const result = await verify(body, await signedHeaders(body));
    expect(result).toMatchObject({ ok: true, event: { kind: 'connection', status: 'failed' } });
  });

  it('rejects a signature made with the wrong secret', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_forged', 'ACTIVE');
    const headers = await signedHeaders(body, { secret: 'not-the-secret' });
    expect(await verify(body, headers)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered body', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_original', 'ACTIVE');
    const headers = await signedHeaders(body);
    const tampered = body.replace('ca_original', 'ca_attacker');
    expect(await verify(tampered, headers)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature bound to a different webhook id', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_replayed', 'ACTIVE');
    const headers = await signedHeaders(body);
    headers.set(WEBHOOK_ID_HEADER, 'msg_other');
    expect(await verify(body, headers)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects stale and far-future timestamps but accepts the tolerance edge', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_time', 'ACTIVE');
    const headers = await signedHeaders(body);
    const toleranceMs = WEBHOOK_TOLERANCE_SECONDS * 1000;
    expect(await verify(body, headers, TEST_NOW_MS + toleranceMs + 1000)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(await verify(body, headers, TEST_NOW_MS - toleranceMs - 1000)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect((await verify(body, headers, TEST_NOW_MS + toleranceMs)).ok).toBe(true);
  });

  it('rejects a non-numeric timestamp', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_time', 'ACTIVE');
    const headers = await signedHeaders(body);
    headers.set(WEBHOOK_TIMESTAMP_HEADER, '1e9');
    expect(await verify(body, headers)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it.each([WEBHOOK_ID_HEADER, WEBHOOK_TIMESTAMP_HEADER, WEBHOOK_SIGNATURE_HEADER])('rejects a missing %s header', async name => {
    const body = connectionEvent(ACTIVATED, 'ca_headers', 'ACTIVE');
    const headers = await signedHeaders(body);
    headers.delete(name);
    expect(await verify(body, headers)).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('fails closed when the secret is empty', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_empty', 'ACTIVE');
    const headers = await signedHeaders(body);
    expect(await verify(body, headers, TEST_NOW_MS, '')).toEqual({ ok: false, reason: 'missing_secret' });
  });

  it('accepts any matching v1 signature among several, as during secret rotation', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_rotated', 'ACTIVE');
    const id = 'msg_rotation';
    const timestamp = String(Math.floor(TEST_NOW_MS / 1000));
    const stale = await sign('old-secret', id, timestamp, body);
    const current = await sign(TEST_WEBHOOK_SECRET, id, timestamp, body);
    const headers = await signedHeaders(body, { id, signature: `v1,${stale} v2,${current} v1,${current}` });
    expect((await verify(body, headers)).ok).toBe(true);
  });

  it('ignores non-v1 and malformed signature entries', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_versions', 'ACTIVE');
    const id = 'msg_versions';
    const timestamp = String(Math.floor(TEST_NOW_MS / 1000));
    const current = await sign(TEST_WEBHOOK_SECRET, id, timestamp, body);
    const headers = await signedHeaders(body, { id, signature: `v2,${current} v1,%%% ${current}` });
    expect(await verify(body, headers)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a body larger than the limit before checking the signature', async () => {
    const body = 'x'.repeat(WEBHOOK_BODY_BYTES_MAX + 1);
    expect(await verify(body, await signedHeaders(body))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('ignores other event types after verifying them', async () => {
    const body = JSON.stringify({ id: 'msg_trigger', type: 'composio.trigger.message', data: { anything: true } });
    const result = await verify(body, await signedHeaders(body));
    expect(result).toEqual({ ok: true, event: { kind: 'ignored', eventId: 'msg_trigger', type: 'composio.trigger.message' } });
  });

  it('ignores connection statuses that settle nothing', async () => {
    const body = connectionEvent(ACTIVATED, 'ca_initiated', 'INITIATED');
    expect(await verify(body, await signedHeaders(body))).toMatchObject({ ok: true, event: { kind: 'ignored' } });
  });

  it.each([
    ['not json', '{'],
    ['no envelope', JSON.stringify({ type: ACTIVATED })],
    ['no account id', JSON.stringify({ id: 'msg_x', type: ACTIVATED, data: { status: 'ACTIVE' } })],
  ])('rejects a signed but malformed payload (%s)', async (_label, body) => {
    expect(await verify(body, await signedHeaders(body))).toEqual({ ok: false, reason: 'bad_payload' });
  });
});
