import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {BootstrapSchema, SyncResponseSchema} from '@praxis/protocol';
import {createApp} from '../app.js';
import {createLocalAdapters} from '../local-memory.js';
import {localDriver} from '../runtime.js';
import {ApiService} from '../service.js';
import {canonicalJSON} from '../sync-routes.js';

function setup() {
  const service = new ApiService(createLocalAdapters(), true);
  service.driver = localDriver(service);
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64')});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {service, req};
}

describe('cursor sync', () => {
  it('pulls replica rows, never secrets, resumes from the bootstrap cursor and returns tombstones', async () => {
    const f = setup();
    await f.req('/v1/providers', {type: 'provider.input', name: 'P', flavor: 'openAIChat', baseUrl: 'https://p.example.test/v1', apiKey: 'sk-secret-value'});
    const full = SyncResponseSchema.parse(await (await f.req('/v1/sync/pull?cursor=0')).json());
    expect(full.entities.some(e => e.key === 'chat:welcome')).toBe(true);
    expect(full.entities.some(e => e.key.startsWith('providerSecret:'))).toBe(false);
    expect(JSON.stringify(full)).not.toContain('sk-secret-value');

    const boot = BootstrapSchema.parse(await (await f.req('/v1/bootstrap')).json());
    expect(boot.syncCursor).toBe(full.cursor);
    const none = SyncResponseSchema.parse(await (await f.req(`/v1/sync/pull?cursor=${boot.syncCursor}`)).json());
    expect(none.entities).toEqual([]);

    await f.req('/v1/chats/welcome', undefined, 'DELETE');
    const delta = SyncResponseSchema.parse(await (await f.req('/v1/sync/pull', {type: 'sync.request', cursor: boot.syncCursor})).json());
    expect(delta.entities.find(e => e.key === 'chat:welcome')).toMatchObject({deleted: true, value: null});
    expect(Number(delta.cursor)).toBeGreaterThan(Number(boot.syncCursor));
  });

  it('pages with nextCursor', async () => {
    const f = setup();
    for (let i = 0; i < 5; i++) await f.req('/v1/chats', {type: 'chat.input', title: `c${i}`});
    const first = SyncResponseSchema.parse(await (await f.req('/v1/sync/pull?cursor=0&limit=2')).json());
    expect(first.nextCursor).not.toBeNull();
    const second = SyncResponseSchema.parse(await (await f.req(`/v1/sync/pull?cursor=${first.nextCursor}&limit=2`)).json());
    expect(second.entities.map(e => e.key)).not.toEqual(first.entities.map(e => e.key));
  });

  it('canonical JSON sorts keys and drops undefined', () => {
    expect(canonicalJSON({b: 1, a: [true, {d: null, c: 'x'}], u: undefined})).toBe('{"a":[true,{"c":"x","d":null}],"b":1}');
  });
});
