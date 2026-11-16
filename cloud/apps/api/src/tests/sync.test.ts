import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {BootstrapSchema, SyncResponseSchema} from '@praxis/protocol';
import {createApp} from '../app.js';
import {createLocalAdapters} from '../local-memory.js';
import {localDriver} from '../runtime.js';
import {ApiService} from '../service.js';
import {canonicalJSON} from '../sync-routes.js';
import {TEST_KEY, connectKey, fakeOpenRouter} from './harness.js';

function setup() {
  const service = new ApiService(createLocalAdapters(), true);
  service.driver = localDriver(service);
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fakeOpenRouter([]).fetcher});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {service, req};
}

describe('cursor sync', () => {
  it('pulls replica rows, never secrets, resumes from the bootstrap cursor and returns tombstones', async () => {
    const f = setup();
    expect((await connectKey(f.req)).status).toBe(200);
    const full = SyncResponseSchema.parse(await (await f.req('/v1/sync/pull?cursor=0')).json());
    expect(full.entities.some(e => e.key === 'chat:welcome')).toBe(true);
    expect(full.entities.some(e => e.key.startsWith('modelKey:'))).toBe(false);
    expect(JSON.stringify(full)).not.toContain(TEST_KEY);
    expect(JSON.stringify(full)).not.toContain('sealed');

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

describe('merkle sync over the API (flagged experiment)', () => {
  it('is off by default, even locally', async () => {
    const f = setup();
    expect((await f.req('/v1/sync/tree', {type: 'sync.request', strategy: 'merkle'})).status).toBe(404);
    expect((await (await f.req('/v1/sync/root')).json()).strategy).toBe('cursor');
  });
  it('converges a replica against the real store and detects nothing-changed in one round trip', async () => {
    process.env.PRAXIS_SYNC_STRATEGY = 'merkle';
    try {
    const {MemoryReplica, syncMerkle} = await import('@praxis/sync');
    const f = setup();
    for (let i = 0; i < 20; i++) await f.req('/v1/chats', {type: 'chat.input', title: `c${i}`});
    const transport = async (r: unknown) => (await f.req('/v1/sync/tree', r)).json();
    const replica = new MemoryReplica();
    await syncMerkle(transport, replica);
    expect([...replica.rows.keys()].filter(k => k.startsWith('chat:')).length).toBe(21);
    await f.req('/v1/chats/welcome', {type: 'chat.patch', title: 'Renamed'}, 'PATCH');
    const stats = await syncMerkle(transport, replica);
    expect(stats.upserts).toBeGreaterThanOrEqual(1);
    expect((replica.rows.get('chat:welcome')!.value as {title: string}).title).toBe('Renamed');
    expect((await syncMerkle(transport, replica)).roundTrips).toBe(1);
    expect((await f.req('/v1/sync/tree', {type: 'sync.request', strategy: 'merkle', prefixes: ['zz']})).status).toBe(400);
    } finally {
      delete process.env.PRAXIS_SYNC_STRATEGY;
    }
  });
});

describe('account setting conflict rules', () => {
  it('keeps independent fields and gives the last committed write to the same field', async () => {
    const f = setup();
    const patch = (field: string, value: string) => f.req('/v1/sync/settings', {field,value}, 'PATCH');
    await patch('theme', 'dark');
    await patch('palette', 'forest');
    await patch('theme', 'light');
    const delta = await (await f.req('/v1/sync/pull?cursor=0')).json();
    const settings = delta.entities.filter((e: {key:string}) => e.key.startsWith('accountSetting:'));
    expect(settings.map((e: {value: unknown}) => e.value)).toEqual(expect.arrayContaining([{field:'theme',value:'light'},{field:'palette',value:'forest'}]));
    expect(settings).toHaveLength(2);
    expect((await patch('secret', 'not allowed')).status).toBe(400);
  });
});

describe('the retired button-colour setting (WP-I1)', () => {
  it('accepts it from older clients without storing it, and never serves a row stored before the removal', async () => {
    const f = setup();
    const patch = (field: string, value: string) => f.req('/v1/sync/settings', {field,value}, 'PATCH');
    expect((await patch('button', '#b6e36b')).status).toBe(200);
    const delta = await (await f.req('/v1/sync/pull?cursor=0')).json();
    expect(delta.entities.some((e: {key: string}) => e.key === 'accountSetting:button')).toBe(false);
    await f.service.adapters.store.put('local-user', 'accountSetting', 'button', {field: 'button', value: '#123abc'});
    expect((await f.service.adapters.store.list('local-user', 'accountSetting')).some(row => (row.value as {field: string}).field === 'button')).toBe(true);
    await patch('palette', 'plum');
    const items = (await (await f.req('/v1/sync/settings')).json()).items as {field: string}[];
    expect(items.map(i => i.field)).toEqual(['palette']);
  });
});
