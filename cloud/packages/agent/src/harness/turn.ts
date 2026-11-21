import {z} from 'zod';
import {isStepCount} from 'ai';
import {JsonValueSchema, ToolInvocationSchema, type JsonObject, type ToolInvocation, type ToolSpec} from '@praxis/protocol';
import {ToolResultSchema, type AgentTool, type ProviderResponse} from '../types.js';
import {executeBoundary, type GateResult} from '../boundary/gate.js';
import {ToolBoundaryError, toolError} from '../boundary/errors.js';
import type {ToolClassifier} from '../boundary/policy.js';
import {canonical} from '../policy.js';
import {turnFailure} from '../turn-failure.js';
import {turnOutput} from '../turn-output.js';
import {requestMessages} from './ai-messages.js';
import {InactiveTurn, ledgerModel, providerFailureOf, providerResponse, type ResponseSlot} from './ai-response.js';
import {frozenPrompt, toolDefinitions} from './prompt.js';
import type {SavedCall, TurnOptions, TurnRun} from './types.js';

export class UncertainToolCall extends Error {
  constructor(readonly callId: string, cause?: unknown) {
    super('Reconcile the durable tool call before resuming this turn.', {cause});
    this.name = 'UncertainToolCall';
  }
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

type Invocation = {id: string; call: ToolInvocation; invalid: boolean};

/** Validates every binding before dispatch, so a malformed later call cannot follow a partial batch. */
function invocations(response: ProviderResponse): Invocation[] {
  const ids = new Set<string>();
  return response.parts.filter(part => part.type === 'toolCall').map(part => {
    if (!part.callId || ids.has(part.callId)) throw new Error('Missing or duplicate tool call id');
    ids.add(part.callId);
    try {
      const call = ToolInvocationSchema.parse({tool: part.name, args: JSON.parse(part.arguments ?? '{}')});
      return {id: part.callId, call, invalid: false};
    } catch {
      return {id: part.callId, call: {tool: part.name ?? '', args: null}, invalid: true};
    }
  });
}

function validateArguments(schema: JsonObject, args: unknown): void {
  try {
    z.fromJSONSchema(schema).parse(args);
  } catch {
    throw new ToolBoundaryError(toolError('schema', 'Arguments do not match the tool schema.'));
  }
}

interface Dispatch {
  options: TurnOptions;
  registry: ToolClassifier;
  offered: readonly ToolSpec[];
  active(): Promise<boolean>;
}

/** One model-issued call through the PRA-76 boundary; an effect whose outcome is unknown stays uncertain. */
async function dispatch(d: Dispatch, {id, call, invalid}: Invocation, tainted: boolean): Promise<SavedCall> {
  const {options} = d;
  const {input, context} = options;
  const tool = options.tools.find(candidate => candidate.spec.name === call.tool);
  const offered = d.offered.find(spec => spec.name === call.tool);
  let dispatched = false;
  let joined = tainted;
  let result: GateResult;
  try {
    if (invalid) throw new ToolBoundaryError(toolError('schema', 'Malformed tool invocation.'));
    if (!input.toolsEnabled || !offered || !tool || tool.hidden || tool.unavailableReason) {
      throw new ToolBoundaryError(toolError('policy-denied', 'This tool is not available in the frozen catalog.'));
    }
    validateArguments(offered.inputSchema, call.args);
    result = await executeBoundary(call, {
      ...options.boundary, mode: input.mode, runId: input.runId, toolCallId: id, taint: {tainted},
    }, d.registry, async checked => {
      if (!await d.active()) throw new UncertainToolCall(id);
      dispatched = true;
      const output = ToolResultSchema.parse(await tool.execute(checked.args, {
        ...context, userId: input.userId, chatId: input.chatId, runId: input.runId,
        mode: input.mode, callId: id, tainted,
        async callTool() {
          throw new ToolBoundaryError(toolError('policy-denied', 'Nested dispatch needs its own durable boundary call.'));
        },
      }));
      joined ||= output.tainted === true;
      return JsonValueSchema.parse(JSON.parse(JSON.stringify(output)));
    }, options.receipts?.[id], undefined, error => {
      if (error instanceof UncertainToolCall || context.signal.aborted) throw error;
      throw new UncertainToolCall(id, error);
    });
  } catch (error) {
    if (error instanceof UncertainToolCall || context.signal.aborted) throw error;
    if (dispatched) throw new UncertainToolCall(id, error);
    result = {ok: false, untrustedSource: false, taint: {tainted}, error: error instanceof ToolBoundaryError
      ? error.detail : toolError('upstream', 'Tool execution failed.')};
  }
  result.taint = {tainted: joined || result.taint.tainted};
  return {call, result};
}

/** One model call plus its tool calls in model order; the ledger makes a retry replay, and the caller commits. */
export async function runTurn(options: TurnOptions): Promise<TurnRun> {
  const {input, ledger, context} = options;
  const prompt = frozenPrompt(input.system, input.tools);
  const active = async () => !context.signal.aborted && await ledger.active();
  if (!await active()) return {state: 'inactive'};
  const prior = await ledger.response();
  const history = prior || !options.rehydrate ? [...input.history] : await options.rehydrate(input.history);
  const slot: ResponseSlot = {};
  try {
    await options.generate({
      model: ledgerModel(options.model, ledger, prior, slot),
      instructions: prompt.system,
      messages: requestMessages(history),
      ...(input.toolsEnabled && prompt.tools.length ? {tools: toolDefinitions(prompt.tools)} : {}),
      stopWhen: isStepCount(1),
      abortSignal: context.signal,
      ...(options.providerOptions ? {providerOptions: options.providerOptions} : {}),
    });
  } catch (error) {
    if (error instanceof InactiveTurn) return {state: 'inactive'};
    const failure = providerFailureOf(error);
    // A revoked key or spent credit cannot succeed on retry; anything else is retried by the workflow.
    const final = turnFailure(failure);
    if (!final) throw failure ?? error;
    return await active() ? {state: 'failed', failure: final} : {state: 'inactive'};
  }
  if (!slot.response) throw new Error('The model call produced no response');
  const response = providerResponse(slot.response);
  const d: Dispatch = {options, registry: toolBoundaryClassifier(options.tools, options.registry), offered: prompt.tools, active};
  const calls: Array<{id: string; saved: SavedCall}> = [];
  let tainted = input.tainted;
  for (const invocation of invocations(response)) {
    if (!await active()) return {state: 'inactive'};
    const claimed = await ledger.startCall(invocation.id, invocation.call);
    if (claimed.state === 'uncertain') throw new UncertainToolCall(invocation.id);
    let saved: SavedCall;
    if (claimed.state === 'saved') {
      saved = claimed.value;
      if (canonical(saved.call) !== canonical(invocation.call)) throw new Error('Durable call binding mismatch');
    } else {
      saved = await dispatch(d, invocation, tainted);
      await ledger.saveCall(invocation.id, saved);
    }
    calls.push({id: invocation.id, saved});
    tainted ||= saved.result.taint.tainted;
  }
  if (!await active()) return {state: 'inactive'};
  return {state: 'output', output: turnOutput({
    chatId: input.chatId, runId: input.runId, response, calls, offered: prompt.tools, tainted,
    nowIso: new Date(options.boundary.nowMs()).toISOString(), newId: options.newId ?? (() => crypto.randomUUID()),
  })};
}
