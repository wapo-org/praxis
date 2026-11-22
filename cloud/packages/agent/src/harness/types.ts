import type {LanguageModelV4} from '@ai-sdk/provider';
import type {ModelMessage, ProviderOptions, ToolSet} from '@ai-sdk/provider-utils';
import type {StopCondition} from 'ai';
import type {Message, Mode, ToolInvocation, ToolSpec, TurnFailure} from '@praxis/protocol';
import type {BoundaryContext, GateResult} from '../boundary/gate.js';
import type {ToolClassifier} from '../boundary/policy.js';
import type {AgentTool, ToolContext} from '../types.js';
import type {TurnOutput} from '../turn-output.js';
import type {SavedResponse} from './ai-response.js';

export type SavedCall = {call: ToolInvocation; result: GateResult};
export type CallClaim = {state: 'new'} | {state: 'uncertain'} | {state: 'saved'; value: SavedCall};

/** Durable per-turn record (Convex `toolState` in production): a retried attempt replays it instead of acting twice. */
export interface TurnLedger {
  response(): Promise<SavedResponse | undefined>;
  saveResponse(response: SavedResponse): Promise<void>;
  /** Marks the call started before any effect; a started call without a result is `uncertain` forever after. */
  startCall(callId: string, call: ToolInvocation): Promise<CallClaim>;
  saveCall(callId: string, value: SavedCall): Promise<void>;
  /** False once the run left this turn (stopped, or fenced by a newer generation or index). */
  active(): Promise<boolean>;
}

/** The AI SDK call one turn makes; production binds it to `@convex-dev/agent`'s `Agent.generateText`. */
export interface TurnGenerateArgs {
  model: LanguageModelV4;
  instructions: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  stopWhen: StopCondition<ToolSet>;
  abortSignal: AbortSignal;
  providerOptions?: ProviderOptions;
}
export type TurnGenerate = (args: TurnGenerateArgs) => Promise<unknown>;

/** What Convex hydrates for one turn: the frozen chat setup, the stored history and the run's taint. */
export interface TurnInput {
  userId: string;
  chatId: string;
  runId: string;
  mode: Mode;
  /** The run's stored taint (`run.taint !== undefined`). */
  tainted: boolean;
  /** Frozen per chat (ConversationSetup): the prefix bytes stay equal turn to turn. */
  system: string;
  tools: readonly ToolSpec[];
  history: readonly Message[];
  /** The model takes tool definitions; without it no tool is offered or dispatched. */
  toolsEnabled: boolean;
}

export interface TurnOptions {
  input: TurnInput;
  model: LanguageModelV4;
  providerOptions?: ProviderOptions;
  generate: TurnGenerate;
  tools: readonly AgentTool[];
  /** Classifies calls the tools' own `boundary` does not cover (Composio metadata, sandbox tools). */
  registry: ToolClassifier;
  ledger: TurnLedger;
  boundary: Pick<BoundaryContext, 'key' | 'replay' | 'nowMs'>;
  receipts?: Readonly<Record<string, unknown>>;
  context: Pick<ToolContext, 'signal' | 'elicit' | 'emit'>;
  /** Request-time attachment reads; history and the ledger keep references. */
  rehydrate?(messages: readonly Message[]): Promise<Message[]>;
  /** Ids for committed messages; defaults to random UUIDs. */
  newId?(): string;
  /** Offloads a result over MAX_RESULT_CHARACTERS before the ledger saves it; without it the result is only truncated. */
  spill?(callId: string, text: string): Promise<string>;
}

export type TurnRun =
  | {state: 'output'; output: TurnOutput}
  | {state: 'inactive'}
  | {state: 'failed'; failure: TurnFailure};
