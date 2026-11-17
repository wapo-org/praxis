import {z} from 'zod';
import {JsonValueSchema, ToolInvocationSchema} from '@praxis/protocol';
import {ProviderResponseSchema, ToolResultSchema, type ProviderResponse, type AgentTool} from './types.js';
import {executeBoundary, type GateResult} from './boundary/gate.js';
import {ToolBoundaryError, toolError} from './boundary/errors.js';
import {canonical} from './policy.js';
import {assembleTurnRequest} from './one-turn-prompt.js';
import {TurnSnapshotSchema, type OneTurnOptions, type SavedCall, type TurnFlags} from './one-turn-state.js';

export class UncertainToolCall extends Error {
  constructor(readonly callId: string) {
    super('Reconcile the durable tool call before resuming this turn.');
  }
}

export async function runOneTurn(options: OneTurnOptions): Promise<TurnFlags> {
  const {store, runId, expectedTurnIndex, provider, context} = options;
  const acquired = await store.acquire(runId, expectedTurnIndex);
  if (acquired.state === 'idle') return acquired.flags;
  const {token} = acquired.claim;
  const snapshot = TurnSnapshotSchema.parse(acquired.claim.snapshot);
  const request = assembleTurnRequest(snapshot.request);
  const active = async () => !context.signal.aborted && await store.active(token);
  if (!await active()) return store.flags(runId);
  let response: ProviderResponse;
  if (acquired.claim.response) {
    response = ProviderResponseSchema.parse(acquired.claim.response);
  } else {
    if (provider.complete) {
      response = ProviderResponseSchema.parse(await provider.complete(request, context.signal));
    } else {
      let completed: ProviderResponse | undefined;
      for await (const event of provider.stream(request, context.signal)) {
        if (event.type === 'completed') {
          completed = ProviderResponseSchema.parse(event.response);
          break;
        }
      }
      if (!completed) throw new Error('Provider stream ended without a completed response');
      response = completed;
    }
    if (!await active()) return store.flags(runId);
    await store.saveResponse(token, response);
  }
  const calls: SavedCall[] = [];
  let tainted = snapshot.tainted;
  const parts = response.parts.filter(part => part.type === 'toolCall');
  const ids = new Set<string>();
  // Validate every binding before dispatch so malformed later calls cannot follow a partial batch.
  const invocations = parts.map(part => {
    if (!part.callId || ids.has(part.callId)) throw new Error('Missing or duplicate tool call id');
    ids.add(part.callId);
    return {id: part.callId, call: ToolInvocationSchema.parse({
      tool: part.name, args: JsonValueSchema.parse(JSON.parse(part.arguments ?? '{}')),
    })};
  });
  for (const {id, call} of invocations) {
    if (!await active()) return store.flags(runId);
    const claimed = await store.startCall(token, id, call);
    if (claimed.state === 'uncertain') throw new UncertainToolCall(id);
    let saved: SavedCall;
    if (claimed.state === 'saved') {
      saved = claimed.value;
      if (canonical(saved.call) !== canonical(call)) throw new Error('Durable call binding mismatch');
    } else {
      const tool = options.tools.find(candidate => candidate.spec.name === call.tool);
      let result: GateResult;
      try {
        validateArguments(tool, call.args);
        result = await executeBoundary(call, {
          ...options.boundary, mode: snapshot.mode, runId, toolCallId: id, taint: {tainted},
        }, options.registry, async checked => {
          if (!await active()) throw new UncertainToolCall(id);
          return ToolResultSchema.parse(await tool!.execute(checked.args, {
            ...context, userId: snapshot.userId, chatId: snapshot.chatId, runId,
            mode: snapshot.mode, callId: id,
            async callTool() {
              throw new ToolBoundaryError(toolError('policy-denied', 'Nested dispatch needs its own durable boundary call.'));
            },
          }));
        }, options.receipts?.[id]);
      } catch (error) {
        if (error instanceof UncertainToolCall || context.signal.aborted) throw error;
        result = {ok: false, error: error instanceof ToolBoundaryError
          ? error.detail : toolError('upstream', 'Tool execution failed.')};
      }
      saved = {call, result};
      await store.saveCall(token, id, saved);
    }
    calls.push(saved);
    if (saved.result.ok) tainted ||= saved.result.taint.tainted;
  }
  if (!await active()) return store.flags(runId);
  return store.commit(token, response, calls, tainted);
}

function validateArguments(tool: AgentTool | undefined, args: unknown): void {
  if (!tool) throw new ToolBoundaryError(toolError('schema', 'Unknown tool.'));
  try {
    z.fromJSONSchema(tool.spec.inputSchema).parse(args);
  } catch {
    throw new ToolBoundaryError(toolError('schema', 'Arguments do not match the tool schema.'));
  }
}
