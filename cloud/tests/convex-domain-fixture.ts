import {afterEach, beforeEach, vi} from 'vitest';
import type {Message} from '@praxis/protocol';
import {api} from '../convex/_generated/api.js';
import {SERVER_TOKEN, signedInUser, workflowTest} from './workflow-fixture.js';

export const NOW = '2026-11-19T00:00:00.000Z';
export const CHAT_ID = 'colliding-chat';
export const TYPED_TABLES = ['chats', 'messages', 'runs', 'turns', 'sandboxes', 'outputs'] as const;
// Each purge call deletes one bounded batch; this ceiling only stops a broken purge from looping forever.
const PURGE_CALLS_MAX = 64;

export type DomainTest = ReturnType<typeof workflowTest>;
export type Viewer = Awaited<ReturnType<typeof signedInUser>>;

// Fake timers keep workflow scheduling inert, so no background function races the assertions.
export function useDomainEnv() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

export function textMessage(id: string, chatId = CHAT_ID, text = id): Message {
  return {
    type: 'message', id, chatId, role: 'user', createdAt: NOW, updatedAt: NOW,
    parts: [{type: 'text', text}],
  };
}

export async function twoOwners() {
  const t = workflowTest();
  const alice = await signedInUser(t);
  const bob = await signedInUser(t);
  return {t, alice, bob};
}

export function createChat(viewer: Viewer, id = CHAT_ID, title = 'Chat') {
  return viewer.client.mutation(api.chats.create, {input: {type: 'chat.input', id, title}});
}

export function commit(t: DomainTest, userId: string, messages: Message[], chatId = CHAT_ID) {
  return t.mutation(api.messages.commit, {
    serverToken: SERVER_TOKEN, userId, chatId, messagesJson: JSON.stringify(messages),
  });
}

export async function purgeUntilDone(t: DomainTest, userId: string) {
  const owner = {serverToken: SERVER_TOKEN, userId};
  await t.mutation(api.account.begin, owner);
  let result: {done: boolean; blobCursor?: string; blobsDone?: boolean} = {done: false};
  let calls = 0;
  while (!result.done && calls < PURGE_CALLS_MAX) {
    result = await t.mutation(api.account.purge, {...owner, blobCursor: result.blobCursor, blobsDone: result.blobsDone});
    calls++;
  }
  return result.done;
}

export function typedRows(t: DomainTest) {
  return t.run(async ctx => {
    const entries = await Promise.all(TYPED_TABLES.map(async table => [table, await ctx.db.query(table).collect()] as const));
    return Object.fromEntries(entries) as {[T in (typeof TYPED_TABLES)[number]]: Array<{userId: string}>};
  });
}
