import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { registerEmail } from '@convex-dev/auth/components/email/test';
import { registerGoogleOauth } from '@convex-dev/auth/components/google/test';
import { registerPassword } from '@convex-dev/auth/components/password/test';
import { registerCore } from '@convex-dev/auth/test';
import { deriveTenantId, SealedSecret } from '@praxis/types';
import { api, internal } from '../convex/_generated/api.js';
import { COMPOSIO_API } from '@praxis/protocol';
import type { ComposioClient } from '../convex/composio/client.js';

const COMPOSIO_API_KEY_ENV = COMPOSIO_API.KEY_ENV;
import {
  ALLOWED_ORIGINS_ENV, COMPOSIO_ERRORS, NATIVE_RETURN_URL, TENANT_ID_SECRET_ENV,
} from '../convex/composio/constants.js';
import schema from '../convex/schema.js';
import { SERVER_TOKEN, signedInUser } from './workflow-fixture.js';

const fake = vi.hoisted(() => ({
  createConnectLink: vi.fn<ComposioClient['createConnectLink']>(),
  revokeConnection: vi.fn<ComposioClient['revokeConnection']>(),
}));

vi.mock(import('../convex/composio/client.js'), async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    composioFor: env => env[COMPOSIO_API_KEY_ENV] ? fake : real.composioFor(env),
  };
});

const origin = 'https://app.praxis.test';
const target = {toolkit: 'gmail', returnTo: `${origin}/apps`};
const TEST_LINK_LIFETIME_MS = 60_000;
const tenantSecret = 'test-tenant-secret-at-least-32-bytes';
const connections = api.composio.connections;

async function setup() {
  const t = convexTest(schema, {
    '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
    '../convex/account.ts': () => import('../convex/account.js'),
    '../convex/composio/actions.ts': () => import('../convex/composio/actions.js'),
    '../convex/composio/connections.ts': () => import('../convex/composio/connections.js'),
    '../convex/composio/connectionStore.ts': () => import('../convex/composio/connectionStore.js'),
  });
  registerCore(t);
  return {t, ...await signedInUser(t)};
}

function link(id: string) {
  return {
    connectedAccountId: id,
    redirectUrl: `https://connect.praxis.test/${id}`,
    expiresAt: Date.now() + TEST_LINK_LIFETIME_MS,
  };
}

describe('Composio connections', () => {
  beforeEach(() => {
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv(ALLOWED_ORIGINS_ENV, origin);
    vi.stubEnv(TENANT_ID_SECRET_ENV, tenantSecret);
    vi.stubEnv(COMPOSIO_API_KEY_ENV, 'test-composio-key');
    fake.createConnectLink.mockReset().mockResolvedValue(link('ca_first'));
    fake.revokeConnection.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('scopes lists to the signed-in user and rejects signed-out callers', async () => {
    const {t, client, userId} = await setup();
    const other = await signedInUser(t);
    await client.action(connections.connect, target);

    expect(await client.query(connections.list, {})).toEqual([expect.objectContaining({userId, toolkit: 'gmail'})]);
    expect(await other.client.query(connections.list, {})).toEqual([]);
    await expect(t.query(connections.list, {})).rejects.toThrow('Authentication required');
  });

  it('sends a tenant ID, stores the pending link and reuses the link on a second click', async () => {
    const {client, userId} = await setup();
    const redirect = await client.action(connections.connect, target);
    expect(await client.action(connections.connect, {...target, toolkit: 'GMAIL'})).toBe(redirect);
    expect(await client.query(connections.list, {})).toEqual([
      expect.objectContaining({status: 'pending', connectedAccountId: 'ca_first', redirectUrl: redirect}),
    ]);
    expect(fake.createConnectLink).toHaveBeenCalledExactlyOnceWith({
      tenantId: await deriveTenantId(userId, SealedSecret.of(tenantSecret)),
      toolkit: target.toolkit,
      callbackUrl: target.returnTo,
    });
  });

  it('keeps a single pending account across overlapping requests and revokes the extra account', async () => {
    const {client} = await setup();
    let finishFirst!: (value: ReturnType<typeof link>) => void;
    const first = new Promise<ReturnType<typeof link>>(resolve => {
      finishFirst = resolve;
    });
    let signalFirst!: () => void;
    const entered = new Promise<void>(resolve => {
      signalFirst = resolve;
    });
    fake.createConnectLink.mockImplementationOnce(() => {
      signalFirst();
      return first;
    }).mockResolvedValueOnce(link('ca_second'));

    const pending = client.action(connections.connect, target);
    await entered;
    const winner = await client.action(connections.connect, target);
    finishFirst(link('ca_first'));

    expect(await pending).toBe(winner);
    expect(await client.query(connections.list, {})).toEqual([
      expect.objectContaining({connectedAccountId: 'ca_second', redirectUrl: winner}),
    ]);
    expect(fake.revokeConnection).toHaveBeenCalledExactlyOnceWith('ca_first');
  });

  it('replaces expired links and ignores late webhooks for the expired account', async () => {
    const {t, client} = await setup();
    await client.action(connections.connect, target);
    await t.run(async ctx => {
      const row = await ctx.db.query('connections').unique();
      if (!row) throw new Error('Expected a connection');
      await ctx.db.patch(row._id, {expiresAt: Date.now() - 1});
    });

    fake.revokeConnection.mockImplementationOnce(async connectedAccountId => {
      await expect(t.mutation(internal.composio.connections.markFromWebhook, {
        connectedAccountId, status: 'connected',
      })).resolves.toBe(false);
    });
    const next = link('ca_next');
    fake.createConnectLink.mockResolvedValueOnce(next);

    await expect(client.action(connections.connect, target)).resolves.toBe(next.redirectUrl);
    expect(fake.revokeConnection).toHaveBeenCalledExactlyOnceWith('ca_first');
    expect(await client.query(connections.list, {})).toEqual([expect.objectContaining(next)]);
  });

  it.each([
    'https://app.praxis.test.evil.test/apps',
    'https://app.praxis.test:444/apps',
    'https://someone@app.praxis.test/apps',
    `${origin}/apps#`,
    `${origin}/apps?state=forged`,
    'javascript:alert(1)',
    'praxis-app://oauth/other',
    `${NATIVE_RETURN_URL}?state=forged`,
  ])('rejects a tampered callback %s', async returnTo => {
    const {client} = await setup();
    await expect(client.action(connections.connect, {...target, returnTo})).rejects.toThrow(COMPOSIO_ERRORS.invalidReturnUrl);
    expect(fake.createConnectLink).not.toHaveBeenCalled();
  });

  it('accepts the exact native callback', async () => {
    const {client} = await setup();
    await client.action(connections.connect, {...target, returnTo: NATIVE_RETURN_URL});
    expect(fake.createConnectLink).toHaveBeenCalledWith(expect.objectContaining({callbackUrl: NATIVE_RETURN_URL}));
  });

  it('preserves the row on a failed revoke, then deletes it after a successful revoke', async () => {
    const {t, client} = await setup();
    await client.action(connections.connect, target);
    await t.mutation(internal.composio.connections.markFromWebhook, {
      connectedAccountId: 'ca_first', status: 'connected',
    });
    fake.revokeConnection.mockRejectedValueOnce(new Error('Revocation failed'));

    const args = {toolkit: 'GMAIL'};
    await expect(client.action(connections.disconnect, args)).rejects.toThrow('Revocation failed');
    expect(await client.query(connections.list, {})).toEqual([expect.objectContaining({status: 'connected'})]);
    await expect(client.action(connections.disconnect, args)).resolves.toBeNull();
    expect(fake.revokeConnection).toHaveBeenLastCalledWith('ca_first');
    expect(await client.query(connections.list, {})).toEqual([]);
  });

  it('purges the deleting owner’s connection and retains other owners’ rows', async () => {
    const {t, client, userId} = await setup();
    for (const register of [registerEmail, registerPassword, registerGoogleOauth]) register(t);
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
    const other = await signedInUser(t);
    await client.action(connections.connect, target);
    fake.createConnectLink.mockResolvedValueOnce(link('ca_other'));
    await other.client.action(connections.connect, target);
    await t.run(ctx => ctx.db.patch(userId, {deleting: true}));

    const scope = {serverToken: SERVER_TOKEN, userId};
    await expect(t.mutation(api.account.purge, scope)).resolves.toEqual({done: false});
    await expect(t.mutation(api.account.purge, scope)).resolves.toEqual({done: true});
    const rows = await t.run(ctx => ctx.db.query('connections').collect());
    expect(rows).toEqual([expect.objectContaining({userId: other.userId, connectedAccountId: 'ca_other'})]);
  });

  it.each([
    [TENANT_ID_SECRET_ENV, COMPOSIO_ERRORS.tenantSecretMissing],
    [COMPOSIO_API_KEY_ENV, `${COMPOSIO_API_KEY_ENV} is not set`],
  ])('fails closed without %s', async (name, error) => {
    const {client} = await setup();
    vi.stubEnv(name, undefined);

    await expect(client.action(connections.connect, target)).rejects.toThrow(error);
    expect(fake.createConnectLink).not.toHaveBeenCalled();
    expect(await client.query(connections.list, {})).toEqual([]);
  });
});
