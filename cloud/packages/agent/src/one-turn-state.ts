import {z} from 'zod';
import {IdSchema, ModeSchema, type ToolInvocation} from '@praxis/protocol';
import {ProviderRequestSchema, type ProviderResponse, type ToolContext, type AgentTool, type ModelProvider} from './types.js';
import type {GateResult, BoundaryContext} from './boundary/gate.js';
import type {ToolClassifier} from './boundary/policy.js';

export const TurnSnapshotSchema = z.object({
  version: z.literal(1), userId: IdSchema, chatId: IdSchema, mode: ModeSchema,
  request: ProviderRequestSchema, tainted: z.boolean(),
});
export type TurnSnapshot = z.infer<typeof TurnSnapshotSchema>;
export type TurnFlags = {turnIndex: number} & (
  {status: 'ready' | 'busy'; done: false} | {status: 'stopped' | 'completed'; done: true}
);
export type SavedCall = {call: ToolInvocation; result: GateResult};
export type TurnClaim = {token: string; snapshot: TurnSnapshot; response?: ProviderResponse};
export type CallClaim = {state: 'new'} | {state: 'uncertain'} | {state: 'saved'; value: SavedCall};

// Convex must implement these atomic, owner-scoped operations; claims cannot expire into blind replay.
export interface TurnStore {
  acquire(runId: string, expectedTurnIndex: number): Promise<{state: 'claimed'; claim: TurnClaim} | {state: 'idle'; flags: TurnFlags}>;
  active(token: string): Promise<boolean>;
  flags(runId: string): Promise<TurnFlags>;
  saveResponse(token: string, response: ProviderResponse): Promise<void>;
  startCall(token: string, callId: string, call: ToolInvocation): Promise<CallClaim>;
  saveCall(token: string, callId: string, value: SavedCall): Promise<void>;
  commit(token: string, response: ProviderResponse, calls: SavedCall[], tainted: boolean): Promise<TurnFlags>;
}

export interface OneTurnOptions {
  runId: string;
  expectedTurnIndex: number;
  store: TurnStore;
  provider: ModelProvider;
  tools: readonly AgentTool[];
  registry: ToolClassifier;
  boundary: Pick<BoundaryContext, 'key' | 'replay' | 'nowMs'>;
  receipts?: Readonly<Record<string, unknown>>;
  context: Pick<ToolContext, 'signal' | 'elicit' | 'emit'>;
}
