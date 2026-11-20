import type {Capabilities, Message, Mode, RunEventPayload} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import {approvalKey} from './boundary/receipt.js';
import {fakeChatModel, fakeRegistry, fakeTools, type FakeEffects, type FakeScript} from './fake-chat-model.js';
import {TestTurnStore} from './one-turn-fixture.js';
import {ONE_TURN_SYSTEM} from './one-turn-prompt.js';
import {buildTurnSnapshot, createTurnAgent} from './turn-harness.js';
import type {RequestTransform} from './request-transforms.js';
import type {TurnFlags} from './one-turn-state.js';
import type {ProviderEvent} from './types.js';

export const SCENARIO_NOW_MS = 1_800_000_000_000;
export const SCENARIO_TIME = new Date(SCENARIO_NOW_MS).toISOString();

export function prompt(id: string, text: string, extra: Message['parts'] = []): Message {
  return {type: 'message', id, chatId: 'chat', role: 'user', parts: [{type: 'text', text}, ...extra],
    createdAt: SCENARIO_TIME, updatedAt: SCENARIO_TIME};
}

export interface ScenarioOptions {
  history?: Message[];
  mode?: Mode;
  capabilities?: Partial<Capabilities>;
  receipts?: Record<string, unknown>;
  transforms?: RequestTransform[];
}

/** One chat on the fake model: a Convex-like store, the per-request agent and everything it emitted. */
export async function scenario(script: FakeScript, options: ScenarioOptions = {}) {
  const effects: FakeEffects = {};
  const tools = fakeTools(effects);
  const model = fakeChatModel(script, options.capabilities);
  const snapshot = buildTurnSnapshot({
    userId: 'user', chatId: 'chat', mode: options.mode ?? 'build', tainted: false, system: ONE_TURN_SYSTEM,
    tools: tools.map(tool => tool.spec), history: options.history ?? [prompt('prompt', 'Hello')],
    model: {id: 'anthropic/claude-sonnet-5.5', capabilities: model.capabilities, maxTokens: 1024},
  });
  const store = new TestTurnStore({snapshot, calls: {}, flags: {turnIndex: 0, status: 'ready', done: false},
    claimed: false, commits: 0, usage: 0, tainted: false, outputs: []});
  const streamed: ProviderEvent[] = [];
  const emitted: RunEventPayload[] = [];
  let ids = 0;
  const key = await approvalKey(SealedSecret.of('k'.repeat(32)));
  const run = (): Promise<TurnFlags> => createTurnAgent({
    provider: model, tools, registry: fakeRegistry, ...(options.transforms ? {transforms: options.transforms} : {}),
    onEvent: event => {
      streamed.push(event);
    },
    newId: () => `msg-${ids++}`,
  }).run({
    runId: 'run', expectedTurnIndex: store.data.flags.turnIndex, store,
    boundary: {key, nowMs: () => SCENARIO_NOW_MS, replay: {consume: async () => true}},
    ...(options.receipts ? {receipts: options.receipts} : {}),
    context: {
      signal: new AbortController().signal,
      elicit: async () => ({type: 'elicitation.response', elicitationId: 'e', action: 'decline'}),
      emit: async event => {
        emitted.push(event);
      },
    },
  });
  /** Delivers turns like the Convex workflow does, one request per turn, until the harness says done. */
  const untilDone = async (maxTurns = 6): Promise<TurnFlags> => {
    for (let turn = 0; turn < maxTurns; turn++) {
      const flags = await run();
      if (flags.done) return flags;
    }
    throw new Error('Scenario did not finish');
  };
  return {model, store, effects, streamed, emitted, key, run, untilDone, history: () => store.data.snapshot.request.messages};
}
