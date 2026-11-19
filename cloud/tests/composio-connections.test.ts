import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { internal } from '../convex/_generated/api.js';
import {
  COMPOSIO_WEBHOOK_PATH,
  COMPOSIO_WEBHOOK_SECRET_ENV,
  PENDING_EXPIRY_BATCH_MAX,
} from '../convex/composio/constants.js';
import schema from '../convex/schema.js';
import { TEST_WEBHOOK_SECRET, connectionEvent, signedHeaders } from './composio-webhook.fixture.js';

const modules = import.meta.glob('../convex/**/*.ts');
const ACTIVATED = 'composio.connected_account.activated';
const HOUR_MS = 60 * 60 * 1000;
type ConnectionStatus = 'pending' | 'connected' | 'failed';

function setup() {
  return convexTest(schema, modules);
}
type ConnectionTest = ReturnType<typeof setup>;

async function insertConnection(
  t: ConnectionTest,
  connectedAccountId: string,
  options: { status?: ConnectionStatus; expiresAt?: number; userId?: string } = {},
) {
  return t.run(async ctx => {
    const userId = options.userId ?? await ctx.db.insert('users', {});
    const now = Date.now();
    return ctx.db.insert('connections', {
      userId,
      toolkit: 'github',
      status: options.status ?? 'pending',
      connectedAccountId,
      redirectUrl: 'https://connect.composio.dev/link/test',
      expiresAt: options.expiresAt ?? now + HOUR_MS,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function statusOf(t: ConnectionTest, connectedAccountId: string) {
  return t.run(async ctx => {
    const row = await ctx.db.query('connections')
      .withIndex('by_connected_account', q => q.eq('connectedAccountId', connectedAccountId))
      .unique();
    return row?.status ?? null;
  });
}

async function post(t: ConnectionTest, body: string, headers: Headers) {
  return t.fetch(COMPOSIO_WEBHOOK_PATH, { method: 'POST', headers, body });
}

describe('Composio webhook route', () => {
  beforeEach(() => {
    process.env[COMPOSIO_WEBHOOK_SECRET_ENV] = TEST_WEBHOOK_SECRET;
  });
  afterEach(() => {
    delete process.env[COMPOSIO_WEBHOOK_SECRET_ENV];
  });

  it('marks a pending row connected for a valid signed activation', async () => {
    const t = setup();
    await insertConnection(t, 'ca_valid');
    const body = connectionEvent(ACTIVATED, 'ca_valid', 'ACTIVE');
    const response = await post(t, body, await signedHeaders(body, { nowMs: Date.now() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: true });
    expect(await statusOf(t, 'ca_valid')).toBe('connected');
  });

  it('leaves the row unchanged for a forged webhook', async () => {
    const t = setup();
    await insertConnection(t, 'ca_forged');
    const body = connectionEvent(ACTIVATED, 'ca_forged', 'ACTIVE');
    const response = await post(t, body, await signedHeaders(body, { nowMs: Date.now(), secret: 'attacker-secret' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'bad_signature' });
    expect(await statusOf(t, 'ca_forged')).toBe('pending');
  });

  it('rejects unsigned requests with 401', async () => {
    const t = setup();
    await insertConnection(t, 'ca_unsigned');
    const body = connectionEvent(ACTIVATED, 'ca_unsigned', 'ACTIVE');
    const response = await post(t, body, new Headers({ 'content-type': 'application/json' }));
    expect(response.status).toBe(401);
    expect(await statusOf(t, 'ca_unsigned')).toBe('pending');
  });

  it('fails closed with 503 when the secret is not configured', async () => {
    delete process.env[COMPOSIO_WEBHOOK_SECRET_ENV];
    const t = setup();
    await insertConnection(t, 'ca_unconfigured');
    const body = connectionEvent(ACTIVATED, 'ca_unconfigured', 'ACTIVE');
    const response = await post(t, body, await signedHeaders(body, { nowMs: Date.now() }));
    expect(response.status).toBe(503);
    expect(await statusOf(t, 'ca_unconfigured')).toBe('pending');
  });

  it('acknowledges unknown event types without touching rows', async () => {
    const t = setup();
    await insertConnection(t, 'ca_other');
    const body = JSON.stringify({ id: 'msg_trigger', type: 'composio.trigger.message', data: { id: 'ca_other' } });
    const response = await post(t, body, await signedHeaders(body, { nowMs: Date.now() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: false });
    expect(await statusOf(t, 'ca_other')).toBe('pending');
  });

  it('acknowledges an activation for an unknown account without applying it', async () => {
    const t = setup();
    const body = connectionEvent(ACTIVATED, 'ca_unknown', 'ACTIVE');
    const response = await post(t, body, await signedHeaders(body, { nowMs: Date.now() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: false });
  });
});

describe('expirePending', () => {
  it('deletes only pending rows past expiresAt', async () => {
    const t = setup();
    const past = Date.now() - HOUR_MS;
    await insertConnection(t, 'ca_expired_pending', { expiresAt: past });
    await insertConnection(t, 'ca_fresh_pending');
    await insertConnection(t, 'ca_expired_connected', { status: 'connected', expiresAt: past });
    await insertConnection(t, 'ca_expired_failed', { status: 'failed', expiresAt: past });
    expect(await t.mutation(internal.composio.expire.expirePending, {})).toEqual({ deleted: 1 });
    expect(await statusOf(t, 'ca_expired_pending')).toBeNull();
    expect(await statusOf(t, 'ca_fresh_pending')).toBe('pending');
    expect(await statusOf(t, 'ca_expired_connected')).toBe('connected');
    expect(await statusOf(t, 'ca_expired_failed')).toBe('failed');
  });

  it('deletes at most PENDING_EXPIRY_BATCH_MAX rows per run', async () => {
    const t = setup();
    const userId = await t.run(ctx => ctx.db.insert('users', {}));
    const past = Date.now() - HOUR_MS;
    const extra = 3;
    for (let index = 0; index < PENDING_EXPIRY_BATCH_MAX + extra; index += 1) {
      await insertConnection(t, `ca_batch_${index}`, { expiresAt: past, userId });
    }
    expect(await t.mutation(internal.composio.expire.expirePending, {})).toEqual({ deleted: PENDING_EXPIRY_BATCH_MAX });
    expect(await t.mutation(internal.composio.expire.expirePending, {})).toEqual({ deleted: extra });
  });
});
