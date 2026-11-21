import {randomBytes} from 'node:crypto';
import {vi} from 'vitest';
import type {Id} from '../convex/_generated/dataModel.js';
import {writeRecord} from '../convex/store.js';
import {ENCRYPTION_KEYRING_ENV, MODEL_KEY_ID, MODEL_KEY_KIND, MODEL_KEY_RESOURCE} from '../convex/agent/constants.js';
import {seal} from '../apps/api/src/secrets.js';
import type {WorkflowTest} from './workflow-fixture.js';

export const TURNS_TO_COMPLETE = 3;
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const TEST_MODEL_KEY = 'sk-or-v1-workflow-test-key';
const NOW = '2026-11-20T00:00:00.000Z';
const SIGNED = {type: 'reasoning.text', text: 'Think.', signature: 'sig-workflow', format: 'anthropic-claude-v1', index: 0};

/** `ready` answers with a tool call (results go back next turn); `completed` answers with text and ends the run. */
export type TurnEnd = 'ready' | 'completed';
export type ModelCall = {expectedTurnIndex: number; generation: number; body: Record<string, unknown>; authorization: string | null};
type Scope = {userId: string; chatId: string; runId: Id<'runs'>};

export function defaultEnd(turnIndex: number, turns = TURNS_TO_COMPLETE): TurnEnd {
  return turnIndex + 1 >= turns ? 'completed' : 'ready';
}

function completion(turnIndex: number, end: TurnEnd) {
  const message = end === 'completed'
    ? {role: 'assistant', content: `answer ${turnIndex}`, reasoning_details: [SIGNED]}
    : {role: 'assistant', content: null, reasoning_details: [SIGNED],
      tool_calls: [{id: `call-${turnIndex}`, type: 'function', function: {name: 'noop', arguments: '{}'}}]};
  return {
    id: `gen-${turnIndex}`, object: 'chat.completion', created: 1_800_000_000, model: 'anthropic/claude-sonnet-5.5',
    choices: [{index: 0, finish_reason: end === 'completed' ? 'stop' : 'tool_calls', message}],
    usage: {prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0001},
  };
}

/** The user's sealed OpenRouter key, written the way `apps/api` connects it, plus the prompt that starts the run. */
export async function seedTurnInputs(t: WorkflowTest, scope: Pick<Scope, 'userId' | 'chatId'>, sealKey = true) {
  const keyring = randomBytes(32).toString('base64');
  vi.stubEnv(ENCRYPTION_KEYRING_ENV, keyring);
  await t.run(async ctx => {
    if (sealKey) {
      const sealed = seal(TEST_MODEL_KEY, scope.userId, MODEL_KEY_RESOURCE, keyring);
      await writeRecord(ctx, {userId: scope.userId, kind: MODEL_KEY_KIND, id: MODEL_KEY_ID, deleted: false,
        value: {type: 'modelKey', maskedKey: '••••-key', connectedAt: NOW, sealed}});
    }
    await writeRecord(ctx, {userId: scope.userId, kind: 'message', id: 'prompt', parentId: scope.chatId, deleted: false,
      value: {type: 'message', id: 'prompt', chatId: scope.chatId, role: 'user', parts: [{type: 'text', text: 'Hello'}],
        createdAt: NOW, updatedAt: NOW}});
  });
}

/** OpenRouter behind `fetch`; each committed turn adds one wire assistant message, so their count is the turn index. */
export async function fakeOpenRouter(t: WorkflowTest, scope: Scope, end: (turnIndex: number) => TurnEnd = defaultEnd, sealKey = true) {
  await seedTurnInputs(t, scope, sealKey);
  const modelCalls: ModelCall[] = [];
  const reply = {override: undefined as ((call: ModelCall) => Response | undefined) | undefined};
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== OPENROUTER_URL) throw new Error(`Unexpected fetch to ${request.url}`);
    const body = await request.json() as {messages: Array<{role: string}>};
    const expectedTurnIndex = body.messages.filter(message => message.role === 'assistant').length;
    const run = await t.run(ctx => ctx.db.get(scope.runId));
    const call = {expectedTurnIndex, generation: run?.workflow?.generation ?? -1, body, authorization: request.headers.get('authorization')};
    modelCalls.push(call);
    return reply.override?.(call) ?? Response.json(completion(expectedTurnIndex, end(expectedTurnIndex)));
  });
  vi.stubGlobal('fetch', fetch);
  return {fetch, modelCalls, reply};
}
