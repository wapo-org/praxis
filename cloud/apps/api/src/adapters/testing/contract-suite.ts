import { beforeEach, describe, expect, it } from 'vitest';
import type { Events, KV, Store } from '../../contracts.js';

/** Unique owner per test so live backends need no cleanup between runs. */
const owner = (label: string) => `${label}-${crypto.randomUUID()}`;

export function storeContract(name: string, factory: () => Store | Promise<Store>) {
  describe(name, () => {
    let store: Store;
    beforeEach(async () => {
      store = await factory();
    });

    it('isolates identical kind/id addresses by owner', async () => {
      const [alice, bob] = [owner('alice'), owner('bob')];
      await store.put(alice, 'chat', 'same', { text: 'a' });
      await store.put(bob, 'chat', 'same', { text: 'b' });
      expect((await store.get(alice, 'chat', 'same'))?.value).toEqual({ text: 'a' });
      expect(await store.get(owner('mallory'), 'chat', 'same')).toBeNull();
      expect(await store.list(bob, 'chat')).toHaveLength(1);
    });

    it('keeps every immutable revision, even for repeated writes in the same millisecond', async () => {
      const [alice, bob] = [owner('alice'), owner('bob')];
      await store.put(alice, 'chat', 'x', { n: 1 });
      await store.put(bob, 'chat', 'hidden', {});
      await store.put(alice, 'chat', 'x', { n: 2 });
      await store.delete(alice, 'chat', 'x');
      const a = await store.changes(alice, 0, 2);
      expect(a.records.map((r) => r.value)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(a.records.every((r) => r.userId === alice)).toBe(true);
      expect(a.hasMore).toBe(true);
      const b = await store.changes(alice, a.cursor, 2);
      expect(b.records).toHaveLength(1);
      expect(b.records[0]?.deleted).toBe(true);
      expect(b.cursor).toBeGreaterThan(a.cursor);
      expect(b.hasMore).toBe(false);
      expect((await store.changes(alice, b.cursor, 2)).records).toEqual([]);
      expect(await store.list(alice, 'chat')).toEqual([]);
    });

    it('reports the owner head revision, 0 when empty, unaffected by other owners', async () => {
      const [alice, bob] = [owner('alice'), owner('bob')];
      expect(await store.head(alice)).toBe(0);
      await store.put(alice, 'chat', 'x', { n: 1 });
      await store.put(bob, 'chat', 'y', { n: 1 });
      await store.delete(alice, 'chat', 'x');
      const head = await store.head(alice);
      const log = await store.changes(alice, 0, 1000);
      expect(head).toBe(log.records.at(-1)?.revision);
      expect(head).toBe(log.cursor);
      await store.put(bob, 'chat', 'z', { n: 2 });
      expect(await store.head(alice)).toBe(head);
      expect((await store.changes(alice, head, 10)).records).toEqual([]);
    });

    it('returns owned data without leaking mutable references', async () => {
      const alice = owner('alice');
      const value = { nested: { n: 1 } };
      const row = await store.put(alice, 'chat', 'x', value);
      value.nested.n = 2;
      (row.value as { nested: unknown }).nested = { n: 3 };
      expect((await store.get(alice, 'chat', 'x'))?.value).toEqual({ nested: { n: 1 } });
    });

    it('creates durable tombstones for deletes and can resurrect a row', async () => {
      const alice = owner('alice');
      await store.delete(alice, 'chat', 'absent');
      expect((await store.get(alice, 'chat', 'absent'))?.deleted).toBe(true);
      await store.put(alice, 'chat', 'absent', { hello: true });
      expect((await store.list(alice, 'chat'))[0]?.deleted).toBe(false);
    });

    it('indexes rows by parentId, keeps it on puts without one, and scopes it by owner and kind', async () => {
      const [alice, bob] = [owner('alice'), owner('bob')];
      await store.put(alice, 'message', 'm1', { n: 1 }, { parentId: 'chat-a' });
      await store.put(alice, 'message', 'm2', { n: 2 }, { parentId: 'chat-b' });
      await store.put(alice, 'message', 'm3', { n: 3 }, { parentId: 'chat-a' });
      await store.put(alice, 'run', 'r1', { n: 4 }, { parentId: 'chat-a' });
      await store.put(bob, 'message', 'm1', { n: 5 }, { parentId: 'chat-a' });
      await store.put(alice, 'message', 'loose', { n: 6 });

      const ids = async (kind: string, parentId?: string) =>
        (await store.list(alice, kind, parentId === undefined ? undefined : { parentId })).map((r) => r.id).sort();
      expect(await ids('message', 'chat-a')).toEqual(['m1', 'm3']);
      expect(await ids('message', 'chat-b')).toEqual(['m2']);
      expect(await ids('run', 'chat-a')).toEqual(['r1']);
      expect(await ids('message')).toEqual(['loose', 'm1', 'm2', 'm3']);
      expect((await store.list(bob, 'message', { parentId: 'chat-a' })).map((r) => r.value)).toEqual([{ n: 5 }]);

      // A put without parentId keeps the existing one; an explicit one moves the row.
      const kept = await store.put(alice, 'message', 'm1', { n: 7 });
      expect(kept.parentId).toBe('chat-a');
      expect((await store.get(alice, 'message', 'm1'))?.parentId).toBe('chat-a');
      await store.put(alice, 'message', 'm3', { n: 8 }, { parentId: 'chat-b' });
      expect(await ids('message', 'chat-a')).toEqual(['m1']);
      expect(await ids('message', 'chat-b')).toEqual(['m2', 'm3']);

      // Tombstones keep their parent (sync needs it) but disappear from lists.
      await store.delete(alice, 'message', 'm1');
      expect((await store.get(alice, 'message', 'm1'))?.parentId).toBe('chat-a');
      expect(await ids('message', 'chat-a')).toEqual([]);
      const log = await store.changes(alice, 0, 1000);
      expect(log.records.at(-1)).toMatchObject({ id: 'm1', deleted: true, parentId: 'chat-a' });
      expect((await store.get(alice, 'message', 'loose'))?.parentId).toBeUndefined();
    });
  });
}

export function kvContract(name: string, factory: () => KV | Promise<KV>, options: { realTime?: boolean } = {}) {
  describe(name, () => {
    let kv: KV;
    beforeEach(async () => {
      kv = await factory();
    });

    it('roundtrips JSON values including strings that look like JSON', async () => {
      const key = owner('kv');
      for (const value of [{ a: [1, 'x', null] }, '{"not":"parsed"}', '42', 0, false, ['x']]) {
        await kv.set(key, value);
        expect(await kv.get(key)).toEqual(value);
      }
      await kv.del(key);
      expect(await kv.get(key)).toBeNull();
      expect(await kv.get(owner('missing'))).toBeNull();
    });

    it('expires values after their TTL', async () => {
      const key = owner('ttl');
      await kv.set(key, { v: 1 }, 1);
      expect(await kv.get(key)).toEqual({ v: 1 });
      if (options.realTime) await new Promise((resolve) => setTimeout(resolve, 2100));
      else await advance(kv, 1100);
      expect(await kv.get(key)).toBeNull();
    });
  });
}

export function eventsContract(name: string, factory: () => Events | Promise<Events>) {
  describe(name, () => {
    let events: Events;
    beforeEach(async () => {
      events = await factory();
    });

    it('latest() names the newest event id, 0 for an empty channel (WP-W3)', async () => {
      expect(events.latest).toBeTypeOf('function');
      expect(await events.latest!('u-latest', 'user')).toBe(0);
      await events.append('u-latest', 'user', {n: 1});
      const second = await events.append('u-latest', 'user', {n: 2});
      expect(await events.latest!('u-latest', 'user')).toBe(second.id);
      expect(await events.read('u-latest', 'user', second.id)).toEqual([]);
    });

    it('allocates monotonic ids per (owner, channel) and reads strictly after a cursor', async () => {
      const [alice, bob] = [owner('alice'), owner('bob')];
      const a1 = await events.append(alice, 'run:1', { type: 'x', n: 1 });
      const a2 = await events.append(alice, 'run:1', { type: 'x', n: 2, nested: { s: '"q"' } });
      const other = await events.append(alice, 'run:2', { type: 'y' });
      const b1 = await events.append(bob, 'run:1', { type: 'z' });
      expect([a1.id, a2.id]).toEqual([1, 2]);
      expect(other.id).toBe(1);
      expect(b1.id).toBe(1);
      expect(await events.read(alice, 'run:1', 0)).toEqual([a1, a2]);
      expect(await events.read(alice, 'run:1', 1)).toEqual([a2]);
      expect(await events.read(alice, 'run:1', 2)).toEqual([]);
      expect(await events.read(bob, 'run:1', 0)).toEqual([b1]);
      expect(await events.read(owner('mallory'), 'run:1', 0)).toEqual([]);
    });

    it('appends a stable event key once under concurrent delivery, scoped to owner/channel', async () => {
      const alice = owner('alice'), bob = owner('bob');
      const delivered = await Promise.all(Array.from({length: 5}, () => events.append(alice, 'run:1', {n: 1, empty: []}, 'outbox:message-1')));
      expect(delivered.every(r => r.id === delivered[0]!.id)).toBe(true);
      expect(await events.read(alice, 'run:1', 0)).toHaveLength(1);
      expect(await events.append(alice, 'run:1', {n: 999}, 'outbox:message-1')).toEqual(delivered[0]);
      expect((await events.append(alice, 'run:1', {n: 2}, 'outbox:message-2')).id).toBe(2);
      expect((await events.append(bob, 'run:1', {n: 3}, 'outbox:message-1')).id).toBe(1);
      expect((await events.append(alice, 'run:2', {n: 4}, 'outbox:message-1')).id).toBe(1);
    });

    it('honours read limits and keeps ids unique under concurrent appends', async () => {
      const alice = owner('alice');
      const appended = await Promise.all(Array.from({ length: 25 }, (_, n) => events.append(alice, 'user', { n })));
      expect(new Set(appended.map((e) => e.id)).size).toBe(25);
      const first = await events.read(alice, 'user', 0, 10);
      expect(first.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      const rest = await events.read(alice, 'user', 10, 100);
      expect(rest.map((e) => e.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 11));
    });
  });
}

/** KV fakes used for TTL tests expose a clock hook; real backends use real time. */
async function advance(kv: KV, ms: number) {
  const clock = (kv as KV & { advanceClock?: (ms: number) => void }).advanceClock;
  if (clock) clock(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms + 1000));
}
