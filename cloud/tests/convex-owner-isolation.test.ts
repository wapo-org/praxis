import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Message} from '@praxis/protocol';
import {api, internal} from '../convex/_generated/api.js';
import {SERVER_TOKEN, signedInUser, workflowTest} from './workflow-fixture.js';

const now = '2026-11-18T00:00:00.000Z';
const chatId = 'shared-chat';
const token = {serverToken: SERVER_TOKEN};
const PURGE_ATTEMPTS_MAX = 24;

function message(id: string, conversation = chatId, text = id): Message {
  return {type: 'message', id, chatId: conversation, role: 'assistant', createdAt: now, updatedAt: now,
    parts: [{type: 'toolResult', text, content: [{nested: {list: [1, null, 'data']}}]}],
    raw: {type: 'provider.payload', data: {nested: [true, {shape: 'opaque'}]}}, sequence: 900};
}

function run(id: string) {
  return {type: 'run', id, chatId, createdAt: now, updatedAt: now, lastEventId: 0, status: 'completed'};
}

async function fixture() {
  const t = workflowTest();
  const alice = await signedInUser(t);
  const bob = await signedInUser(t);
  await alice.client.mutation(api.chats.create, {input: {type: 'chat.input', id: chatId, title: 'Alice'}});
  return {t, alice, bob};
}

describe('Convex typed owner storage', () => {
  beforeEach(() => {
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('creates, reads, patches and removes chats through verified viewer identity', async () => {
    const {t, alice, bob} = await fixture();
    expect(await bob.client.query(api.chats.get, {chatId})).toBeNull();
    expect(await bob.client.query(api.chats.list, {})).toEqual([]);
    expect(await bob.client.mutation(api.chats.patch, {chatId, input: {type: 'chat.patch', title: 'Foreign'}})).toBeNull();
    expect(await bob.client.mutation(api.chats.remove, {chatId})).toBe(false);
    const bobChat = await bob.client.mutation(api.chats.create, {
      input: {type: 'chat.input', id: chatId, title: 'Bob', mode: 'ask', connectorIds: ['connector']},
    });
    expect(bobChat).toMatchObject({id: chatId, title: 'Bob', mode: 'ask'});
    expect(await bob.client.mutation(api.chats.patch, {chatId, input: {type: 'chat.patch', title: 'Updated'}}))
      .toMatchObject({title: 'Updated', mode: 'ask', connectorIds: ['connector']});
    expect(await alice.client.query(api.chats.get, {chatId})).toMatchObject({title: 'Alice'});
    expect(await bob.client.mutation(api.chats.remove, {chatId})).toBe(true);
    expect(await bob.client.query(api.chats.get, {chatId})).toBeNull();
    expect(await bob.client.query(api.chats.list, {})).toEqual([]);
    expect(await t.query(api.store.get, {...token, userId: bob.userId, kind: 'chat', id: chatId}))
      .toMatchObject({deleted: true});
    expect(await t.run(ctx => ctx.db.query('records').collect())).toEqual([]);
  });

  it('requires authenticated viewers and the secret, and fences an owner during deletion', async () => {
    const {t, alice, bob} = await fixture();
    const scope = {...token, userId: alice.userId, chatId};
    const messagesJson = JSON.stringify([message('private')]);
    await expect(t.query(api.chats.list, {})).rejects.toThrow('Authentication required');
    await expect(t.mutation(api.chats.create, {input: {type: 'chat.input'}})).rejects.toThrow('Authentication required');
    await expect(bob.client.query(api.chats.get, {chatId, userId: alice.userId} as {chatId: string})).rejects.toThrow();
    await expect(t.mutation(api.messages.commit, {...scope, messagesJson, serverToken: 'wrong'}))
      .rejects.toThrow('Server authentication required');
    await expect(t.mutation(api.messages.commit, {...scope, userId: bob.userId, messagesJson}))
      .rejects.toThrow('Chat unavailable');
    await expect(t.mutation(api.store.put, {...token, userId: bob.userId, kind: 'message', id: 'private', value: message('private')}))
      .rejects.toThrow('Chat unavailable');
    await t.mutation(api.messages.commit, {...scope, messagesJson});
    await t.mutation(api.account.begin, {...token, userId: alice.userId});
    await expect(alice.client.query(api.messages.page, {chatId, limit: 10})).rejects.toThrow('Account unavailable');
    await expect(alice.client.query(api.runs.get, {runId: 'r'})).rejects.toThrow('Account unavailable');
    await expect(alice.client.mutation(api.chats.remove, {chatId})).rejects.toThrow('Account unavailable');
    await expect(t.mutation(api.messages.commit, {...scope, messagesJson})).rejects.toThrow('Account unavailable');
    await expect(t.mutation(api.store.remove, {...token, userId: alice.userId, kind: 'message', id: 'private'}))
      .rejects.toThrow('Account unavailable');
    expect(await t.query(api.store.get, {...token, userId: alice.userId, kind: 'message', id: 'private'})).toBeNull();
    expect((await t.query(api.store.changes, {...token, userId: alice.userId, after: 0, limit: 10})).records).toEqual([]);
  });

  it('assigns gap-free sequences in concurrent batches, rolls back failed batches and pages by sequence', async () => {
    const {t, alice, bob} = await fixture();
    const scope = {...token, userId: alice.userId, chatId};
    const commit = (...messages: Message[]) => t.mutation(api.messages.commit, {...scope, messagesJson: JSON.stringify(messages)});
    const original = message('a');
    const [left, right] = await Promise.all([commit(original, message('b')), commit(message('c'), message('d'))]);
    expect(left[1]!.sequence).toBe(left[0]!.sequence! + 1);
    expect(right[1]!.sequence).toBe(right[0]!.sequence! + 1);
    expect([...left, ...right].map(row => row.sequence).sort()).toEqual([1, 2, 3, 4]);
    expect((await commit(message('a', chatId, 'patched')))[0]).toMatchObject({
      sequence: left[0]!.sequence, raw: original.raw, parts: [{text: 'patched', content: original.parts[0]!.content}],
    });
    await expect(commit(message('should-roll-back'), message('foreign', 'another-chat'))).rejects.toThrow('does not match');
    expect((await commit(message('e')))[0]?.sequence).toBe(5);
    const first = await alice.client.query(api.messages.page, {chatId, limit: 2});
    expect(first).toMatchObject({messages: [{sequence: 1}, {sequence: 2}], cursor: 2, hasMore: true});
    const next = await alice.client.query(api.messages.page, {chatId, after: first.cursor, limit: 10});
    expect(next).toMatchObject({messages: [{sequence: 3}, {sequence: 4}, {id: 'e', sequence: 5}], cursor: 5, hasMore: false});
    expect(await bob.client.query(api.messages.page, {chatId, limit: 10})).toMatchObject({messages: [], hasMore: false});
    await t.mutation(api.store.remove, {...token, userId: alice.userId, kind: 'message', id: 'e'});
    expect((await commit(message('f')))[0]?.sequence).toBe(6);
  });

  it('reads only owned runs and uses typed output chunks through the existing Store', async () => {
    const {t, alice, bob} = await fixture();
    const owner = {...token, userId: alice.userId};
    const record = {kind: 'run', id: 'r'};
    await t.mutation(api.store.put, {...owner, ...record, value: run('r')});
    expect(await alice.client.query(api.runs.get, {runId: 'r'})).toMatchObject(run('r'));
    expect(await bob.client.query(api.runs.get, {runId: 'r'})).toBeNull();
    await expect(t.mutation(api.store.put, {...token, userId: bob.userId, ...record, value: run('r')}))
      .rejects.toThrow('Chat unavailable');
    await t.mutation(api.store.put, {...owner, ...record, value: {...run('r'), note: 'updated'}});
    expect(await alice.client.query(api.runs.get, {runId: 'r'})).toMatchObject({note: 'updated'});
    const output = {kind: 'outputChunk', id: 'chunk', parentId: 'manifest'};
    await t.mutation(api.store.put, {...owner, ...output, value: {chatId, text: 'first'}});
    await t.mutation(api.store.put, {...owner, kind: output.kind, id: output.id, value: {chatId, text: 'second'}});
    expect(await t.query(api.store.list, {...owner, kind: output.kind, parentId: output.parentId}))
      .toMatchObject([{id: output.id, value: {chatId, text: 'second'}}]);
    expect(await t.query(api.store.get, {...token, userId: bob.userId, kind: output.kind, id: output.id})).toBeNull();
    await t.mutation(api.store.remove, {...owner, kind: output.kind, id: output.id});
    expect(await t.query(api.store.list, {...owner, kind: output.kind})).toEqual([]);
    await t.mutation(api.store.remove, {...owner, ...record});
    expect(await alice.client.query(api.runs.get, {runId: 'r'})).toBeNull();
  });

  it('purges all six typed tables for one owner and preserves colliding data for the other', async () => {
    const {t, alice, bob} = await fixture();
    await bob.client.mutation(api.chats.create, {input: {type: 'chat.input', id: chatId}});
    for (const {userId, client} of [alice, bob]) {
      const owner = {...token, userId};
      const runId = await client.mutation(api.runs.start, {chatId});
      await t.mutation(internal.turns.commitStub, {userId, chatId, runId, generation: 0, expectedTurnIndex: 0});
      await t.mutation(api.messages.commit, {...owner, chatId, messagesJson: JSON.stringify([message('same')])});
      await t.mutation(api.store.put, {...owner, kind: 'outputChunk', id: 'chunk', parentId: 'manifest', value: {chatId, text: 'secret'}});
      await t.run(async ctx => {
        const id = await ctx.db.insert('sandboxes', {userId, chatId, sandboxId: 'instance', volumeName: 'volume',
          status: 'starting', lastUsedAt: now});
        await ctx.db.patch(id, {status: 'running'});
        expect(await ctx.db.query('sandboxes').withIndex('by_user_chat', q =>
          q.eq('userId', userId).eq('chatId', chatId)).unique()).toMatchObject({status: 'running'});
      });
    }
    const typedTables = ['chats', 'messages', 'runs', 'turns', 'sandboxes', 'outputs'] as const;
    const snapshot = () => t.run(ctx => Promise.all(typedTables.map(table => ctx.db.query(table).collect())));
    const before = await snapshot();
    expect(before.every(rows => rows.length === 2)).toBe(true);
    const owner = {...token, userId: alice.userId};
    await t.mutation(api.account.begin, owner);
    let done = false;
    for (let attempt = 0; !done && attempt < PURGE_ATTEMPTS_MAX; attempt++) {
      ({done} = await t.mutation(api.account.purge, owner));
    }
    expect(done).toBe(true);
    const after = await snapshot();
    expect(after).toEqual(before.map(rows => rows.filter(row => row.userId === bob.userId)));
  });
});
