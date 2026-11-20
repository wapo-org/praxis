import type {Capabilities, Message, Mode, ReasoningEffort, ToolSpec} from '@praxis/protocol';
import type {ToolClassifier} from './boundary/policy.js';
import type {AgentTool, ModelProvider} from './types.js';
import type {RequestTransform} from './request-transforms.js';
import {runOneTurn} from './one-turn.js';
import {assembleTurnRequest} from './one-turn-prompt.js';
import {TurnSnapshotSchema, type OneTurnOptions, type TurnFlags, type TurnSnapshot} from './one-turn-state.js';

/** What the worker reads from Convex to start one turn: the frozen chat setup, history and model. */
export interface TurnSnapshotInput {
  userId: string;
  chatId: string;
  mode: Mode;
  /** The run's stored taint (`run.taint !== undefined`). */
  tainted: boolean;
  /** Frozen per chat (ConversationSetup): the prefix bytes stay equal turn to turn. */
  system: string;
  tools: readonly ToolSpec[];
  history: readonly Message[];
  model: {id: string; capabilities: Capabilities; maxTokens: number; effort?: ReasoningEffort; temperature?: number};
}

/** Builds the snapshot a TurnStore claim carries; history that fails the message mapper throws here. */
export function buildTurnSnapshot(input: TurnSnapshotInput): TurnSnapshot {
  const {model} = input;
  const request = assembleTurnRequest({
    model: model.id, system: input.system, messages: [...input.history], tools: [...input.tools],
    capabilities: model.capabilities, maxTokens: model.maxTokens,
    ...(model.effort ? {effort: model.effort} : {}),
    ...(model.temperature === undefined ? {} : {temperature: model.temperature}),
  });
  return TurnSnapshotSchema.parse({
    version: 1, userId: input.userId, chatId: input.chatId, mode: input.mode, tainted: input.tainted, request,
  });
}

/** Everything that is fixed for one request: the model, the tool registry and the request middleware. */
export interface TurnAgentConfig {
  provider: ModelProvider;
  tools: readonly AgentTool[];
  /** Classifies calls the tools' own `boundary` does not cover (Composio metadata, sandbox tools). */
  registry: ToolClassifier;
  transforms?: readonly RequestTransform[];
  onEvent?: OneTurnOptions['onEvent'];
  newId?: OneTurnOptions['newId'];
}

/** The per-delivery half: which turn to run, its durable store, approval receipts and the live context. */
export type TurnInvocation = Pick<OneTurnOptions, 'runId' | 'expectedTurnIndex' | 'store' | 'boundary' | 'receipts' | 'context'>;

export interface TurnAgent {
  /** Runs exactly one model response and its tool calls, commits once, and says whether more turns remain. */
  run(invocation: TurnInvocation): Promise<TurnFlags>;
}

/** A tool's own trusted classification (web tools, PRA-60) wins; the configured registry covers the rest. */
export function toolBoundaryClassifier(tools: readonly AgentTool[], fallback: ToolClassifier): ToolClassifier {
  const own = new Map(tools.flatMap(tool => tool.boundary ? [[tool.spec.name, tool.boundary] as const] : []));
  return {
    classify(call) {
      return own.get(call.tool) ?? fallback.classify(call);
    },
  };
}

/** Built per request and discarded with it: state comes from the TurnStore snapshot and leaves through its commit. */
export function createTurnAgent(config: TurnAgentConfig): TurnAgent {
  const names = config.tools.map(tool => tool.spec.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate tool names in the turn registry');
  const registry = toolBoundaryClassifier(config.tools, config.registry);
  return {
    run(invocation) {
      return runOneTurn({
        ...invocation, provider: config.provider, tools: config.tools, registry,
        ...(config.transforms ? {transforms: config.transforms} : {}),
        ...(config.onEvent ? {onEvent: config.onEvent} : {}),
        ...(config.newId ? {newId: config.newId} : {}),
      });
    },
  };
}
