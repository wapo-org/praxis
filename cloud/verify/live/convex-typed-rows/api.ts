import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {ChatSchema, MessageSchema, RunSchema, type Message} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import {z} from 'zod';

type Args = Record<string, unknown>;
const query = (name: string) => makeFunctionReference<'query', Args, unknown>(name);
const mutation = (name: string) => makeFunctionReference<'mutation', Args, unknown>(name);

const REFS = {
  chatsList: query('chats:list'),
  chatsGet: query('chats:get'),
  chatsCreate: mutation('chats:create'),
  chatsPatch: mutation('chats:patch'),
  chatsRemove: mutation('chats:remove'),
  messagesPage: query('messages:page'),
  messagesCommit: mutation('messages:commit'),
  runsGet: query('runs:get'),
  runsStart: mutation('runs:start'),
} as const;

export const ChatReply = ChatSchema.nullable();
export const PageReply = z.object({messages: z.array(MessageSchema), cursor: z.number().int().nonnegative(), hasMore: z.boolean()});
export const RunReply = RunSchema.nullable();
export type Page = z.infer<typeof PageReply>;

/** Every public call the live check makes, each reply parsed with the protocol schema so a malformed row fails. */
export function typedApi(client: ConvexHttpClient) {
  return {
    listChats: async () => z.array(ChatSchema).parse(await client.query(REFS.chatsList, {})),
    getChat: async (chatId: string) => ChatReply.parse(await client.query(REFS.chatsGet, {chatId})),
    createChat: async (id: string, title: string) => ChatSchema.parse(await client.mutation(REFS.chatsCreate, {
      input: {type: 'chat.input', id, title},
    })),
    renameChat: async (chatId: string, title: string) => ChatReply.parse(await client.mutation(REFS.chatsPatch, {
      chatId, input: {type: 'chat.patch', title},
    })),
    removeChat: async (chatId: string) => z.boolean().parse(await client.mutation(REFS.chatsRemove, {chatId})),
    page: async (chatId: string, limit: number, after?: number) => PageReply.parse(await client.query(REFS.messagesPage, {
      chatId, limit, ...(after === undefined ? {} : {after}),
    })),
    getRun: async (runId: string) => RunReply.parse(await client.query(REFS.runsGet, {runId})),
    startRun: async (chatId: string) => z.string().min(1).parse(await client.mutation(REFS.runsStart, {chatId})),
  };
}

export type TypedApi = ReturnType<typeof typedApi>;

/** The service-to-Convex commit path; owner scoping comes from `userId` because the caller is the trusted worker. */
export async function commitMessages(client: ConvexHttpClient, serverToken: SealedSecret, userId: string, chatId: string, messages: Message[]) {
  return z.array(MessageSchema).parse(await client.mutation(REFS.messagesCommit, {
    serverToken: serverToken.reveal(), userId, chatId, messagesJson: JSON.stringify(messages),
  }));
}

export function textMessage(chatId: string, id: string, role: Message['role'], text: string, now = new Date()): Message {
  const stamp = now.toISOString();
  return MessageSchema.parse({type: 'message', id, chatId, role, parts: [{type: 'text', text}], createdAt: stamp, updatedAt: stamp});
}
