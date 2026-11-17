import {CapabilitiesSchema, type ToolInvocation} from '@praxis/protocol';
import {approvalKey} from './boundary/receipt.js';
import {SealedSecret} from '@praxis/types';
import {textResult, type ProviderResponse, type AgentTool, type ModelProvider} from './types.js';
import {ONE_TURN_SYSTEM} from './one-turn-prompt.js';
import type {TurnFailure} from '@praxis/protocol';
import type {CallClaim, OneTurnOptions, SavedCall, TurnFlags, TurnSnapshot, TurnStore} from './one-turn-state.js';

export const response = (calls = false): ProviderResponse => ({
  parts: calls ? [{type: 'toolCall', callId: 'call', name: 'read', arguments: '{"query":"hello"}'}] : [{type: 'text', text: 'done'}],
  stop: calls ? 'toolUse' : 'endTurn', usage: {type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0},
});
/** Makes the fixture model answer `next()` on every call, through the stream like a real provider. */
export function answerWith(provider: ModelProvider, next: () => Promise<ProviderResponse>): void {
  provider.stream = async function* () {
    yield {type: 'completed', response: await next()};
  };
}
export const testTool: AgentTool = {
  spec: {type: 'tool.spec', name: 'read', description: 'Read external data.', inputSchema: {
    type: 'object', properties: {query: {type: 'string'}}, required: ['query'], additionalProperties: false,
  }, source: {type: 'builtin'}, traits: ['readOnly']},
  async execute() {
    return textResult('external');
  },
};
export const snapshot = (): TurnSnapshot => ({
  version: 1, userId: 'user', chatId: 'chat', mode: 'auto', tainted: false,
  request: {model: 'model', system: ONE_TURN_SYSTEM, messages: [], tools: [testTool.spec],
    capabilities: CapabilitiesSchema.parse({}), maxTokens: 100},
});

// This fake models atomic Convex operations; production needs durable fencing, not an in-memory lease.
export class TestTurnStore implements TurnStore {
  data: {snapshot: TurnSnapshot; response?: ProviderResponse; calls: Record<string, SavedCall | null>;
    flags: TurnFlags; claimed: boolean; commits: number; usage: number; tainted: boolean};
  constructor(data?: TestTurnStore['data']) {
    this.data = data ?? {snapshot: snapshot(), calls: {}, flags: {turnIndex: 0, status: 'ready', done: false},
      claimed: false, commits: 0, usage: 0, tainted: false};
  }
  async acquire(_runId: string, expected: number) {
    if (this.data.claimed || this.data.flags.done || this.data.flags.turnIndex !== expected) {
      const flags: TurnFlags = this.data.claimed
        ? {turnIndex: this.data.flags.turnIndex, status: 'busy', done: false} : this.data.flags;
      return {state: 'idle' as const, flags};
    }
    this.data.claimed = true;
    return {state: 'claimed' as const, claim: {token: 'fence', snapshot: structuredClone(this.data.snapshot), response: this.data.response}};
  }
  async active() {
    return this.data.claimed && !this.data.flags.done;
  }
  async flags() {
    return this.data.flags;
  }
  async saveResponse(_token: string, value: ProviderResponse) {
    this.data.response = structuredClone(value);
  }
  async startCall(_token: string, id: string, _call: ToolInvocation): Promise<CallClaim> {
    if (Object.hasOwn(this.data.calls, id)) {
      const value = this.data.calls[id];
      return value ? {state: 'saved', value} : {state: 'uncertain'};
    }
    this.data.calls[id] = null;
    return {state: 'new'};
  }
  async saveCall(_token: string, id: string, value: SavedCall) {
    this.data.calls[id] = structuredClone(value);
  }
  async commit(_token: string, value: ProviderResponse, _calls: SavedCall[], tainted: boolean) {
    if (!await this.active()) return this.data.flags;
    this.data.commits++;
    this.data.usage += value.usage.inputTokens;
    this.data.tainted ||= tainted;
    this.data.flags = {turnIndex: this.data.flags.turnIndex + 1, ...(value.stop === 'toolUse' ? {status: 'ready', done: false} : {status: 'completed', done: true})};
    this.data.claimed = false;
    return this.data.flags;
  }
  async fail(_token: string, failure: TurnFailure) {
    if (!await this.active()) return this.data.flags;
    this.data.flags = {turnIndex: this.data.flags.turnIndex, status: 'failed', done: true, failure};
    this.data.claimed = false;
    return this.data.flags;
  }
  stop() {
    this.data.flags = {...this.data.flags, status: 'stopped', done: true};
  }
  rehydrateAfterFencing(): TestTurnStore {
    const data: TestTurnStore['data'] = JSON.parse(JSON.stringify(this.data));
    data.claimed = false;
    return new TestTurnStore(data);
  }
}

export async function fixture(calls = false): Promise<OneTurnOptions & {store: TestTurnStore; counts: {model: number; tool: number}}> {
  const counts = {model: 0, tool: 0};
  const key = await approvalKey(SealedSecret.of('a'.repeat(32)));
  return {
    runId: 'run', expectedTurnIndex: 0, store: new TestTurnStore(), counts,
    provider: {capabilities: CapabilitiesSchema.parse({}), async *stream() {
      counts.model++;
      yield {type: 'completed', response: response(calls)};
    }},
    tools: [{...testTool, async execute() {
      counts.tool++;
      return textResult('external');
    }}],
    registry: {classify: () => ({capabilities: ['read'], decision: 'allow', untrustedSource: true})},
    boundary: {key, nowMs: () => 1, replay: {consume: async () => true}},
    context: {signal: new AbortController().signal, elicit: async () => ({action: 'decline', type: 'elicitation.response', elicitationId: 'request'}), emit: async () => {}},
  };
}
