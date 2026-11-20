import {Hono} from 'hono';
import {vi} from 'vitest';
import {
  TURN_CURRENT_KEY_ENV, TURN_KEY_MIN_CHARACTERS, TurnCommitResultSchema,
  type Message, type TurnCommit, type TurnRequest,
} from '@praxis/protocol';
import {api} from '../convex/_generated/api.js';
import {TURN_WORKER_URL_ENV} from '../convex/workflows/constants.js';
import {createMemoryAdapters} from '../apps/api/src/adapters/memory.js';
import {readTurnKeys} from '../apps/api/src/turn/auth.js';
import {TurnIndexConflict} from '../apps/api/src/turn/conflict.js';
import {registerTurnRoute} from '../apps/api/src/turn/routes.js';
import {SERVER_TOKEN, type WorkflowTest} from './workflow-fixture.js';

export const WORKER_ORIGIN = 'https://worker.test';
export const TURNS_TO_COMPLETE = 3;
const SIGNING_KEY = 'k'.repeat(TURN_KEY_MIN_CHARACTERS);
const NOW = '2026-11-20T00:00:00.000Z';

export type TurnScope = Pick<TurnRequest, 'userId' | 'chatId' | 'runId' | 'generation' | 'expectedTurnIndex'>;
export type TurnPlan = Pick<TurnCommit, 'end'> & Partial<Pick<TurnCommit, 'messages' | 'usage' | 'taint'>>;

export function assistantMessage(request: TurnScope, parts: Message['parts'] = [{type: 'text', text: 'answer'}]): Message {
  return {
    type: 'message', id: `${request.runId}-turn-${request.expectedTurnIndex}`, chatId: request.chatId,
    runId: request.runId, role: 'assistant', createdAt: NOW, updatedAt: NOW, parts,
  };
}

/** Three model turns, the last one completing: what the PRA-29 stub used to fake inside Convex. */
export function defaultPlan(request: TurnScope): TurnPlan {
  const last = request.expectedTurnIndex + 1 >= TURNS_TO_COMPLETE;
  return {end: {status: last ? 'completed' : 'ready'}, messages: [assistantMessage(request)]};
}

export function commitArgs(request: TurnScope, plan: TurnPlan = defaultPlan(request)) {
  const {userId, chatId, runId, generation, expectedTurnIndex} = request;
  const commit: TurnCommit = {
    userId, chatId, runId, generation, expectedTurnIndex,
    messages: plan.messages ?? [],
    end: plan.end,
    ...(plan.usage && {usage: plan.usage}),
    ...(plan.taint && {taint: plan.taint}),
  };
  return {serverToken: SERVER_TOKEN, userId: request.userId, commitJson: JSON.stringify(commit)};
}

/** The real PRA-38 route and verifier behind `fetch`; its fake model step commits through `turns.commit`. */
export function fakeTurnWorker(t: WorkflowTest, plan: (request: TurnScope) => TurnPlan = defaultPlan) {
  vi.stubEnv(TURN_WORKER_URL_ENV, WORKER_ORIGIN);
  vi.stubEnv(TURN_CURRENT_KEY_ENV, SIGNING_KEY);
  const adapters = createMemoryAdapters();
  const modelCalls: TurnRequest[] = [];
  const reply = {override: undefined as (() => Response | undefined) | undefined};
  adapters.turn = {
    async execute(request) {
      modelCalls.push(request);
      const result = TurnCommitResultSchema.parse(await t.mutation(api.turns.commit, commitArgs(request, plan(request))));
      if (result.outcome === 'conflict') throw new TurnIndexConflict();
      return result.flags;
    },
  };
  const app = new Hono();
  registerTurnRoute(app, adapters, readTurnKeys({[TURN_CURRENT_KEY_ENV]: SIGNING_KEY}));
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== WORKER_ORIGIN) throw new Error(`Unexpected fetch to ${request.url}`);
    return reply.override?.() ?? app.fetch(request);
  });
  vi.stubGlobal('fetch', fetch);
  return {fetch, modelCalls, reply};
}
