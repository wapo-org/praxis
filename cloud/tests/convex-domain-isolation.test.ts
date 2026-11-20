import {describe, expect, it, vi} from 'vitest';
import {api} from '../convex/_generated/api.js';
import {SERVER_TOKEN} from './workflow-fixture.js';
import {commitArgs} from './workflow-worker.js';
import {
  CHAT_ID, NOW, TYPED_TABLES, commit, createChat, purgeUntilDone, textMessage, twoOwners, typedRows, useDomainEnv,
  type DomainTest, type Viewer,
} from './convex-domain-fixture.js';

const token = {serverToken: SERVER_TOKEN};
const CONCURRENT_COMMITS = 6;
const MESSAGES_PER_COMMIT = 3;

// Writes one row into each of the six typed tables for the viewer, keyed by the shared colliding ids.
async function seedAllTables(t: DomainTest, viewer: Viewer) {
  const {userId, client} = viewer;
  await createChat(viewer);
  const runId = await client.mutation(api.runs.start, {chatId: CHAT_ID});
  await t.mutation(api.turns.commit, commitArgs({userId, chatId: CHAT_ID, runId, generation: 0, expectedTurnIndex: 0}, {end: {status: 'ready'}}));
  await commit(t, userId, [textMessage('same-message', CHAT_ID, `secret of ${userId}`)]);
  await t.mutation(api.store.put, {...token, userId, kind: 'outputChunk', id: 'same-chunk', parentId: 'manifest',
    valueJson: JSON.stringify({chatId: CHAT_ID, text: `output of ${userId}`})});
  await t.run(ctx => ctx.db.insert('sandboxes', {userId, chatId: CHAT_ID, sandboxId: 'sbx', volumeName: 'vol',
    status: 'running', lastUsedAt: NOW}));
  return runId;
}

describe('PRA-24 owner isolation', () => {
  useDomainEnv();

  it('a second owner cannot get, list, page, patch or remove another owner\'s chat rows', async () => {
    const {t, alice, bob} = await twoOwners();
    const aliceRun = await seedAllTables(t, alice);
    const before = await typedRows(t);
    expect(await bob.client.query(api.chats.get, {chatId: CHAT_ID})).toBeNull();
    expect(await bob.client.query(api.chats.list, {})).toEqual([]);
    expect(await bob.client.query(api.messages.page, {chatId: CHAT_ID, limit: 10}))
      .toEqual({messages: [], cursor: 0, hasMore: false});
    expect(await bob.client.query(api.runs.get, {runId: aliceRun})).toBeNull();
    expect(await bob.client.mutation(api.chats.patch, {chatId: CHAT_ID, input: {type: 'chat.patch', title: 'Stolen'}}))
      .toBeNull();
    expect(await bob.client.mutation(api.chats.remove, {chatId: CHAT_ID})).toBe(false);
    await expect(bob.client.mutation(api.runs.start, {chatId: CHAT_ID})).rejects.toThrow('Run or chat unavailable');
    await expect(bob.client.mutation(api.runs.cancel, {runId: aliceRun})).rejects.toThrow('Run or chat unavailable');
    const foreign = {userId: bob.userId, chatId: CHAT_ID, runId: aliceRun, generation: 0, expectedTurnIndex: 1};
    expect(await t.mutation(api.turns.commit, commitArgs(foreign))).toEqual({outcome: 'conflict'});
    expect(await typedRows(t)).toEqual(before);
    expect(await alice.client.query(api.chats.get, {chatId: CHAT_ID})).toMatchObject({title: 'Chat'});
    expect(await alice.client.query(api.runs.get, {runId: aliceRun})).toMatchObject({status: 'running'});
  });

  it('server Store reads and removes for one owner never resolve another owner\'s rows', async () => {
    const {t, alice, bob} = await twoOwners();
    await seedAllTables(t, alice);
    const bobScope = {...token, userId: bob.userId};
    for (const [kind, id] of [['chat', CHAT_ID], ['message', 'same-message'], ['outputChunk', 'same-chunk']] as const) {
      expect(await t.query(api.store.get, {...bobScope, kind, id})).toBeNull();
      expect(await t.query(api.store.list, {...bobScope, kind})).toEqual([]);
      await t.mutation(api.store.remove, {...bobScope, kind, id});
    }
    const rows = await typedRows(t);
    for (const table of ['chats', 'messages', 'outputs'] as const) {
      expect(rows[table].map(row => row.userId)).toEqual([alice.userId]);
    }
    expect(await t.query(api.store.get, {...token, userId: alice.userId, kind: 'message', id: 'same-message'}))
      .toMatchObject({value: {parts: [{text: `secret of ${alice.userId}`}]}});
  });

  it('a message or output that names another owner\'s chat is looked up by (userId, chatId) and rejected', async () => {
    const {t, alice, bob} = await twoOwners();
    await createChat(alice);
    await expect(commit(t, bob.userId, [textMessage('intrusion')])).rejects.toThrow('Chat unavailable');
    await expect(t.mutation(api.store.put, {...token, userId: bob.userId, kind: 'outputChunk', id: 'intrusion',
      parentId: 'manifest', valueJson: JSON.stringify({chatId: CHAT_ID, text: 'x'})})).rejects.toThrow('Chat unavailable');
    const rows = await typedRows(t);
    expect(rows.messages).toEqual([]);
    expect(rows.outputs).toEqual([]);
    expect((await alice.client.query(api.messages.page, {chatId: CHAT_ID, limit: 10})).messages).toEqual([]);
  });

  it('owner functions throw when there is no identity, and take no client owner argument', async () => {
    const {t, alice} = await twoOwners();
    const aliceRun = await seedAllTables(t, alice);
    const anonymous = [
      () => t.query(api.chats.list, {}),
      () => t.query(api.chats.get, {chatId: CHAT_ID}),
      () => t.query(api.messages.page, {chatId: CHAT_ID, limit: 10}),
      () => t.query(api.runs.get, {runId: aliceRun}),
      () => t.mutation(api.chats.create, {input: {type: 'chat.input', title: 'x'}}),
      () => t.mutation(api.chats.patch, {chatId: CHAT_ID, input: {type: 'chat.patch', title: 'x'}}),
      () => t.mutation(api.chats.remove, {chatId: CHAT_ID}),
      () => t.mutation(api.runs.start, {chatId: CHAT_ID}),
      () => t.mutation(api.runs.cancel, {runId: aliceRun}),
    ];
    for (const call of anonymous) await expect(call()).rejects.toThrow('Authentication required');
    const withOwner = {chatId: CHAT_ID, userId: alice.userId} as {chatId: string};
    await expect(t.query(api.chats.get, withOwner)).rejects.toThrow();
    expect(await alice.client.query(api.chats.get, {chatId: CHAT_ID})).toMatchObject({title: 'Chat'});
  });

  it('serverMutation and server Store calls reject a bad or unconfigured internal secret', async () => {
    const {t, alice} = await twoOwners();
    await createChat(alice);
    const messagesJson = JSON.stringify([textMessage('m')]);
    const attempt = (serverToken: string) => [
      () => t.mutation(api.messages.commit, {serverToken, userId: alice.userId, chatId: CHAT_ID, messagesJson}),
      () => t.mutation(api.store.put, {serverToken, userId: alice.userId, kind: 'message', id: 'm', valueJson: JSON.stringify(textMessage('m'))}),
      () => t.mutation(api.store.remove, {serverToken, userId: alice.userId, kind: 'chat', id: CHAT_ID}),
      () => t.query(api.store.get, {serverToken, userId: alice.userId, kind: 'chat', id: CHAT_ID}),
      () => t.mutation(api.account.begin, {serverToken, userId: alice.userId}),
      () => t.mutation(api.account.purge, {serverToken, userId: alice.userId}),
    ];
    for (const call of [...attempt('wrong'), ...attempt('')]) {
      await expect(call()).rejects.toThrow('Server authentication required');
    }
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', '');
    for (const call of attempt(SERVER_TOKEN)) await expect(call()).rejects.toThrow('Server authentication required');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
    const rows = await typedRows(t);
    expect(rows.messages).toEqual([]);
    expect(rows.chats).toHaveLength(1);
  });

  it('concurrent messages.commit calls produce one contiguous, duplicate-free sequence per chat', async () => {
    const {t, alice, bob} = await twoOwners();
    await createChat(alice);
    await createChat(bob);
    const batch = (owner: string, index: number) => Array.from({length: MESSAGES_PER_COMMIT}, (_, offset) =>
      textMessage(`${owner}-${index}-${offset}`));
    const results = await Promise.all(Array.from({length: CONCURRENT_COMMITS}, (_, index) => [
      commit(t, alice.userId, batch('a', index)),
      commit(t, bob.userId, batch('b', index)),
    ]).flat());
    for (const result of results) {
      const sequences = result.map(row => row.sequence!);
      expect(sequences).toEqual(sequences.map((_, offset) => sequences[0]! + offset));
    }
    const total = CONCURRENT_COMMITS * MESSAGES_PER_COMMIT;
    const expected = Array.from({length: total}, (_, index) => index + 1);
    for (const viewer of [alice, bob]) {
      const page = await viewer.client.query(api.messages.page, {chatId: CHAT_ID, limit: total + 1});
      expect(page.messages.map(row => row.sequence)).toEqual(expected);
      expect(page.hasMore).toBe(false);
    }
    const chats = await t.run(ctx => ctx.db.query('chats').collect());
    expect(chats.map(chat => chat.lastSequence)).toEqual([total, total]);
  });

  it('account purge leaves zero rows in all six typed tables while the other owner\'s rows stay intact', async () => {
    const {t, alice, bob} = await twoOwners();
    await seedAllTables(t, alice);
    await seedAllTables(t, bob);
    const before = await typedRows(t);
    for (const table of TYPED_TABLES) expect(before[table]).toHaveLength(2);
    expect(await purgeUntilDone(t, alice.userId)).toBe(true);
    const after = await typedRows(t);
    for (const table of TYPED_TABLES) {
      expect(after[table].filter(row => row.userId === alice.userId)).toEqual([]);
      expect(after[table]).toEqual(before[table].filter(row => row.userId === bob.userId));
    }
    expect(await bob.client.query(api.chats.get, {chatId: CHAT_ID})).toMatchObject({id: CHAT_ID});
    expect((await bob.client.query(api.messages.page, {chatId: CHAT_ID, limit: 10})).messages)
      .toMatchObject([{id: 'same-message', parts: [{text: `secret of ${bob.userId}`}]}]);
  });
});
