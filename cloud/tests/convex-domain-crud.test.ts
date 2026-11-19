import {describe, expect, it} from 'vitest';
import {api, internal} from '../convex/_generated/api.js';
import {SERVER_TOKEN} from './workflow-fixture.js';
import {CHAT_ID, NOW, commit, createChat, textMessage, twoOwners, useDomainEnv} from './convex-domain-fixture.js';

const token = {serverToken: SERVER_TOKEN};

describe('PRA-24 typed table CRUD through domain functions', () => {
  useDomainEnv();

  it('chats: create, get, list, patch and soft-remove for the verified viewer', async () => {
    const {t, alice} = await twoOwners();
    const generated = await alice.client.mutation(api.chats.create, {input: {type: 'chat.input', title: 'Generated'}});
    expect(generated.id).toEqual(expect.any(String));
    const named = await createChat(alice, CHAT_ID, 'Named');
    expect(named).toMatchObject({type: 'chat', id: CHAT_ID, title: 'Named', mode: 'build', pinned: false});
    expect(await alice.client.query(api.chats.get, {chatId: CHAT_ID})).toEqual(named);
    expect((await alice.client.query(api.chats.list, {})).map(chat => chat.id).sort())
      .toEqual([CHAT_ID, generated.id].sort());
    await expect(createChat(alice, CHAT_ID)).rejects.toThrow('Chat ID unavailable');
    const patched = await alice.client.mutation(api.chats.patch, {
      chatId: CHAT_ID, input: {type: 'chat.patch', pinned: true, title: 'Renamed'},
    });
    expect(patched).toMatchObject({id: CHAT_ID, pinned: true, title: 'Renamed', createdAt: named.createdAt});
    expect(patched?.titleRevision).toEqual(expect.any(String));
    expect(await alice.client.mutation(api.chats.remove, {chatId: CHAT_ID})).toBe(true);
    expect(await alice.client.mutation(api.chats.remove, {chatId: CHAT_ID})).toBe(false);
    expect(await alice.client.query(api.chats.get, {chatId: CHAT_ID})).toBeNull();
    expect(await alice.client.mutation(api.chats.patch, {chatId: CHAT_ID, input: {type: 'chat.patch', title: 'Late'}}))
      .toBeNull();
    expect((await alice.client.query(api.chats.list, {})).map(chat => chat.id)).toEqual([generated.id]);
    const stored = await t.run(ctx => ctx.db.query('chats').withIndex('by_user_id', q =>
      q.eq('userId', alice.userId).eq('id', CHAT_ID)).unique());
    expect(stored?.value.deletedAt).toEqual(expect.any(String));
  });

  it('messages: commit assigns sequences, page reads them, re-commit updates in place, remove deletes', async () => {
    const {t, alice} = await twoOwners();
    await createChat(alice);
    const created = await commit(t, alice.userId, [textMessage('m1'), {...textMessage('m2'), sequence: 99}]);
    expect(created.map(row => [row.id, row.sequence])).toEqual([['m1', 1], ['m2', 2]]);
    const updated = await commit(t, alice.userId, [textMessage('m1', CHAT_ID, 'edited')]);
    expect(updated).toMatchObject([{id: 'm1', sequence: 1, parts: [{type: 'text', text: 'edited'}]}]);
    const page = await alice.client.query(api.messages.page, {chatId: CHAT_ID, limit: 10});
    expect(page.messages.map(row => [row.id, row.sequence, row.parts[0]?.text]))
      .toEqual([['m1', 1, 'edited'], ['m2', 2, 'm2']]);
    expect(page).toMatchObject({cursor: 2, hasMore: false});
    await t.mutation(api.store.remove, {...token, userId: alice.userId, kind: 'message', id: 'm1'});
    const after = await alice.client.query(api.messages.page, {chatId: CHAT_ID, limit: 10});
    expect(after.messages.map(row => row.id)).toEqual(['m2']);
    await expect(commit(t, alice.userId, [textMessage('m3', 'other-chat')], 'other-chat')).rejects.toThrow('Chat unavailable');
    await createChat(alice, 'other-chat');
    // The stored parent is checked before the chat lookup, so a moved message fails on its address.
    await expect(commit(t, alice.userId, [textMessage('m2', 'other-chat')], 'other-chat'))
      .rejects.toThrow('Record address does not match value');
    expect((await alice.client.query(api.messages.page, {chatId: 'other-chat', limit: 10})).messages).toEqual([]);
  });

  it('runs: start creates an owned workflow run, get reads it, cancel updates it; Store runs round-trip', async () => {
    const {t, alice} = await twoOwners();
    await createChat(alice);
    const runId = await alice.client.mutation(api.runs.start, {chatId: CHAT_ID});
    expect(await alice.client.query(api.runs.get, {runId})).toMatchObject({id: runId, chatId: CHAT_ID, status: 'running'});
    await alice.client.mutation(api.runs.cancel, {runId});
    const cancelled = await t.run(ctx => ctx.db.get(runId));
    expect(cancelled).toMatchObject({userId: alice.userId, chatId: CHAT_ID, workflow: {status: 'cancelling'}});
    const owner = {...token, userId: alice.userId, kind: 'run', id: 'store-run'};
    const value = {type: 'run', id: 'store-run', chatId: CHAT_ID, status: 'running', createdAt: NOW, updatedAt: NOW, lastEventId: 0};
    await t.mutation(api.store.put, {...owner, value});
    await t.mutation(api.store.put, {...owner, value: {...value, status: 'completed', lastEventId: 4}});
    expect(await alice.client.query(api.runs.get, {runId: 'store-run'})).toMatchObject({status: 'completed', lastEventId: 4});
    expect(await t.query(api.store.list, {...token, userId: alice.userId, kind: 'run', parentId: CHAT_ID}))
      .toMatchObject([{id: 'store-run'}]);
    await t.mutation(api.store.remove, owner);
    expect(await alice.client.query(api.runs.get, {runId: 'store-run'})).toBeNull();
    expect(await alice.client.query(api.runs.get, {runId})).toMatchObject({id: runId});
  });

  it('turns: commitStub inserts owner-indexed turns, replays saved turns and rejects skipped indexes', async () => {
    const {t, alice} = await twoOwners();
    await createChat(alice);
    const runId = await alice.client.mutation(api.runs.start, {chatId: CHAT_ID});
    const scope = {userId: alice.userId, chatId: CHAT_ID, runId, generation: 0};
    const first = await t.mutation(internal.turns.commitStub, {...scope, expectedTurnIndex: 0});
    expect(first).toMatchObject({turnIndex: 0, done: false, status: 'ready'});
    expect(await t.mutation(internal.turns.commitStub, {...scope, expectedTurnIndex: 0})).toEqual(first);
    await expect(t.mutation(internal.turns.commitStub, {...scope, expectedTurnIndex: 5})).rejects.toThrow('Unexpected turn index');
    expect(await t.mutation(internal.turns.commitStub, {...scope, expectedTurnIndex: 1})).toMatchObject({turnIndex: 1});
    const turns = await t.run(ctx => ctx.db.query('turns').withIndex('by_user_run_turn', q =>
      q.eq('userId', alice.userId).eq('runId', runId)).collect());
    expect(turns.map(turn => [turn.turnIndex, turn.status])).toEqual([[0, 'ready'], [1, 'ready']]);
    expect(await t.run(ctx => ctx.db.get(runId))).toMatchObject({workflow: {nextTurnIndex: 2}});
  });

  it('sandboxes: rows insert, read by (userId, chatId), patch and delete', async () => {
    const {t, alice, bob} = await twoOwners();
    const row = {chatId: CHAT_ID, sandboxId: 'sbx', volumeName: 'vol', status: 'starting' as const, lastUsedAt: NOW};
    const byOwner = (userId: string) => t.run(ctx => ctx.db.query('sandboxes')
      .withIndex('by_user_chat', q => q.eq('userId', userId).eq('chatId', CHAT_ID)).unique());
    const id = await t.run(ctx => ctx.db.insert('sandboxes', {...row, userId: alice.userId}));
    expect(await byOwner(alice.userId)).toMatchObject({_id: id, status: 'starting'});
    expect(await byOwner(bob.userId)).toBeNull();
    await t.run(ctx => ctx.db.patch(id, {status: 'running'}));
    expect(await byOwner(alice.userId)).toMatchObject({status: 'running'});
    await t.run(ctx => ctx.db.delete(id));
    expect(await byOwner(alice.userId)).toBeNull();
  });

  it('outputs: Store put/get/list/update/remove keep chunks addressed by owner and parent', async () => {
    const {t, alice} = await twoOwners();
    await createChat(alice);
    const owner = {...token, userId: alice.userId};
    const chunk = {kind: 'outputChunk', id: 'chunk-1'};
    await t.mutation(api.store.put, {...owner, ...chunk, parentId: 'manifest', value: {chatId: CHAT_ID, text: 'one'}});
    expect(await t.query(api.store.get, {...owner, ...chunk}))
      .toMatchObject({id: 'chunk-1', parentId: 'manifest', value: {chatId: CHAT_ID, text: 'one'}, deleted: false});
    await t.mutation(api.store.put, {...owner, ...chunk, parentId: 'manifest', value: {chatId: CHAT_ID, text: 'two'}});
    expect(await t.query(api.store.list, {...owner, kind: 'outputChunk', parentId: 'manifest'}))
      .toMatchObject([{id: 'chunk-1', value: {text: 'two'}}]);
    await expect(t.mutation(api.store.put, {...owner, ...chunk, parentId: 'other', value: {chatId: CHAT_ID, text: 'x'}}))
      .rejects.toThrow('Output chunk address cannot change');
    await expect(t.mutation(api.store.put, {...owner, kind: 'outputChunk', id: 'orphan', parentId: 'manifest',
      value: {chatId: 'missing-chat', text: 'x'}})).rejects.toThrow('Chat unavailable');
    await t.mutation(api.store.remove, {...owner, ...chunk});
    expect(await t.query(api.store.list, {...owner, kind: 'outputChunk'})).toEqual([]);
    expect(await t.run(ctx => ctx.db.query('outputs').collect())).toEqual([]);
  });
});
