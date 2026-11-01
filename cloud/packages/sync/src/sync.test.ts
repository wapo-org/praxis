import {describe, expect, it} from 'vitest';
import {HashTree, bucketOf, canonicalJSON, sha256Hex} from './tree.js';
import {MemoryReplica} from './memory.js';
import {SyncSimulator} from './simulator.js';
import {syncCursor, syncMerkle} from './sync.js';

async function seeded(n: number) {
  const server = new SyncSimulator();
  for (let i = 0; i < n; i++) await server.put(`message:${i}`, {type: 'message', id: String(i), text: `hello ${i}`});
  return server;
}
const transport = (server: SyncSimulator) => (r: Parameters<SyncSimulator['handle']>[0]) => server.handle(structuredClone(r));

describe('portable hashing', () => {
  it('has fixed vectors Swift must reproduce', async () => {
    expect(canonicalJSON({b: [1, {d: true, c: null}], a: 'x'})).toBe('{"a":"x","b":[1,{"c":null,"d":true}]}');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bucketOf('')).toBe('811c9dc5');
    expect(bucketOf('a')).toBe('e40c292c');
    const t = new HashTree({depth: 1});
    expect(await t.root()).toBe('');
  });
  it('root is independent of insertion order', async () => {
    const a = new HashTree(), b = new HashTree();
    for (let i = 0; i < 100; i++) a.set(`k${i}`, `h${i}`);
    for (let i = 99; i >= 0; i--) b.set(`k${i}`, `h${i}`);
    expect(await a.root()).toBe(await b.root());
    b.set('k5', 'changed');
    expect(await a.root()).not.toBe(await b.root());
    b.set('k5', 'h5');
    expect(await a.root()).toBe(await b.root());
  });
});

describe('sync strategies converge', () => {
  it('cursor and merkle both reach the server state after updates, inserts and deletes', async () => {
    const server = await seeded(2000);
    const cursorReplica = new MemoryReplica(), merkleReplica = new MemoryReplica();
    await syncCursor(transport(server), cursorReplica);
    const initial = await syncMerkle(transport(server), merkleReplica);
    expect(merkleReplica.rows.size).toBe(2000);
    expect(initial.roundTrips).toBe(4);
    await server.put('message:7', {type: 'message', id: '7', text: 'edited'});
    await server.put('message:new', {type: 'message', id: 'new', text: 'new'});
    server.delete('message:9');
    const c = await syncCursor(transport(server), cursorReplica);
    const m = await syncMerkle(transport(server), merkleReplica);
    expect(c).toMatchObject({roundTrips: 1, upserts: 2, deletes: 1});
    expect(m).toMatchObject({upserts: 2, deletes: 1});
    for (const r of [cursorReplica, merkleReplica]) {
      expect(r.rows.size).toBe(2000);
      expect(r.rows.get('message:7')?.value).toMatchObject({text: 'edited'});
      expect(r.rows.has('message:9')).toBe(false);
      expect(await r.tree.root()).toBe(await server.tree.root());
    }
    const noop = await syncMerkle(transport(server), merkleReplica);
    expect(noop.roundTrips).toBe(1);
  });
  it('merkle repairs a replica whose cursor is lost and that holds a stale row', async () => {
    const server = await seeded(300);
    const replica = new MemoryReplica();
    await syncCursor(transport(server), replica);
    replica.cursor = '0';
    await replica.apply([{type: 'sync.entity', key: 'message:ghost', hash: 'x', updatedAt: '', deleted: false, value: {}}], [], '0');
    await syncMerkle(transport(server), replica);
    expect(replica.rows.has('message:ghost')).toBe(false);
    expect(await replica.tree.root()).toBe(await server.tree.root());
    expect(replica.cursor).toBe(String(server.revision));
  });
});
