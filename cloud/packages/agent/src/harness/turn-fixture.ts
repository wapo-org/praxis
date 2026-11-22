import {generateText} from 'ai';
import {SealedSecret} from '@praxis/types';
import type {Message, Mode, RunEventPayload, ToolInvocation, ToolSpec} from '@praxis/protocol';
import {approvalKey} from '../boundary/receipt.js';
import {textResult, type AgentTool} from '../types.js';
import type {TurnOutput} from '../turn-output.js';
import type {SavedResponse} from './ai-response.js';
import {fakeLanguageModel, fakeRegistry, fakeTools, type FakeEffects, type FakeLanguageModel, type FakeReply, type FakeScript} from './fake-model.js';
import {TURN_SYSTEM} from './prompt.js';
import {runTurn} from './turn.js';
import type {CallClaim, SavedCall, TurnGenerate, TurnLedger, TurnOptions, TurnRun} from './types.js';

export const SCENARIO_NOW_MS = 1_800_000_000_000;
export const SCENARIO_TIME = new Date(SCENARIO_NOW_MS).toISOString();

/** The AI SDK generator the component wraps; package tests call it directly, Convex tests go through `Agent`. */
export const directGenerate: TurnGenerate = args => generateText(args);

/** In-memory stand-in for the Convex ledger rows and the turn commit fence. */
export class MemoryLedger implements TurnLedger {
  saved?: SavedResponse;
  calls: Record<string, SavedCall | null> = {};
  stopped = false;
  responseSaves = 0;

  async response() {
    return this.saved && structuredClone(this.saved);
  }
  async saveResponse(response: SavedResponse) {
    this.responseSaves++;
    this.saved = structuredClone(response);
  }
  async startCall(id: string, _call: ToolInvocation): Promise<CallClaim> {
    if (Object.hasOwn(this.calls, id)) {
      const value = this.calls[id];
      return value ? {state: 'saved', value: structuredClone(value)} : {state: 'uncertain'};
    }
    this.calls[id] = null;
    return {state: 'new'};
  }
  async saveCall(id: string, value: SavedCall) {
    this.calls[id] = JSON.parse(JSON.stringify(value));
  }
  async active() {
    return !this.stopped;
  }
  /** What a fresh attempt sees after the process died: the same durable rows, as JSON. */
  rehydrated(): MemoryLedger {
    const next = new MemoryLedger();
    next.saved = this.saved && JSON.parse(JSON.stringify(this.saved));
    next.calls = JSON.parse(JSON.stringify(this.calls));
    next.stopped = this.stopped;
    return next;
  }
}

export function prompt(id: string, text: string, extra: Message['parts'] = []): Message {
  return {type: 'message', id, chatId: 'chat', role: 'user', parts: [{type: 'text', text}, ...extra],
    createdAt: SCENARIO_TIME, updatedAt: SCENARIO_TIME};
}

export const readTool: AgentTool = {
  spec: {type: 'tool.spec', name: 'read', description: 'Read external data.', inputSchema: {
    type: 'object', properties: {query: {type: 'string'}}, required: ['query'], additionalProperties: false,
  }, source: {type: 'builtin'}, traits: ['readOnly']},
  async execute() {
    return textResult('external');
  },
};

export const readCall = (callId = 'call', args = '{"query":"hello"}'): FakeReply => ({calls: [{id: callId, name: 'read', args}]});

export interface TurnFixture extends TurnOptions {
  model: FakeLanguageModel;
  ledger: MemoryLedger;
  counts: {model: number; tool: number};
  emitted: RunEventPayload[];
}

/** One turn's options on the fake model with a single untrusted `read` tool, like the PRA-78 prototype fixture. */
export async function turnFixture(script: FakeScript = [readCall()], specs?: ToolSpec[]): Promise<TurnFixture> {
  const counts = {model: 0, tool: 0};
  const emitted: RunEventPayload[] = [];
  const model = fakeLanguageModel((options, index) => {
    counts.model++;
    const reply = typeof script === 'function' ? script(options, index) : script[index];
    if (!reply) throw new Error(`Fake model has no reply for call ${index}`);
    return reply;
  });
  const tool: AgentTool = {...readTool, async execute() {
    counts.tool++;
    return textResult('external');
  }};
  let ids = 0;
  return {
    input: {userId: 'user', chatId: 'chat', runId: 'run', mode: 'auto', tainted: false, system: TURN_SYSTEM,
      tools: specs ?? [readTool.spec], history: [prompt('prompt', 'Hello')], toolsEnabled: true},
    model, generate: directGenerate, tools: [tool], ledger: new MemoryLedger(), counts, emitted,
    registry: {classify: () => ({capabilities: ['read'], decision: 'allow', untrustedSource: true})},
    boundary: {key: await approvalKey(SealedSecret.of('a'.repeat(32))), nowMs: () => SCENARIO_NOW_MS, replay: {consume: async () => true}},
    context: {
      signal: new AbortController().signal,
      elicit: async () => ({type: 'elicitation.response', elicitationId: 'request', action: 'decline'}),
      emit: async event => {
        emitted.push(event);
      },
    },
    newId: () => `msg-${ids++}`,
  };
}

export interface ScenarioOptions {
  history?: Message[];
  mode?: Mode;
  receipts?: Record<string, unknown>;
  rehydrate?: TurnOptions['rehydrate'];
  toolsEnabled?: boolean;
}

/** One chat on the fake model with the scenario tools: each `run` is one workflow turn, committed in memory. */
export async function scenario(script: FakeScript, options: ScenarioOptions = {}) {
  const effects: FakeEffects = {};
  const base = await turnFixture(script);
  const tools = fakeTools(effects);
  const history = [...options.history ?? [prompt('prompt', 'Hello')]];
  const outputs: TurnOutput[] = [];
  let tainted = false;
  let ledger = new MemoryLedger();
  const run = async (): Promise<TurnRun> => {
    const result = await runTurn({
      ...base, tools, registry: fakeRegistry, ledger,
      input: {...base.input, mode: options.mode ?? 'build', tainted, tools: tools.map(tool => tool.spec), history: [...history],
        toolsEnabled: options.toolsEnabled ?? true},
      ...(options.receipts ? {receipts: options.receipts} : {}),
      ...(options.rehydrate ? {rehydrate: options.rehydrate} : {}),
    });
    if (result.state === 'output') {
      // Like `turns.commit`: messages join the history the next turn hydrates, and the ledger starts empty.
      outputs.push(structuredClone(result.output));
      history.push(...structuredClone(result.output.messages));
      tainted ||= result.output.tainted;
      ledger = new MemoryLedger();
    }
    return result;
  };
  const untilDone = async (maxTurns = 6): Promise<TurnOutput> => {
    for (let turn = 0; turn < maxTurns; turn++) {
      const result = await run();
      if (result.state !== 'output') throw new Error(`Turn ended ${result.state}`);
      if (result.output.end.status === 'completed') return result.output;
    }
    throw new Error('Scenario did not finish');
  };
  return {model: base.model, key: base.boundary.key, effects, outputs, history: () => history, emitted: base.emitted,
    run, untilDone, ledger: () => ledger};
}
