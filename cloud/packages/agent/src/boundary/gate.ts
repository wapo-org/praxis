import {ToolInvocationSchema, type ToolInvocation, type ToolError, type JsonValue, type Mode} from '@praxis/protocol';
import {ApprovalReceipt, argsHash, type ApprovalReplayStore} from './receipt.js';
import {classifyInvocation, isSideEffect, resultTaint, type ToolClassifier, type MetaToolAdapter, type TaintState, type BoundaryResult} from './policy.js';
import {boundaryDecision} from './decision.js';
import {ToolBoundaryError, toolError} from './errors.js';

export type GateResult = {ok: true; result: BoundaryResult; taint: TaintState} | {ok: false; error: ToolError; untrustedSource: boolean; taint: TaintState};
export interface BoundaryContext {
  mode: Mode;
  runId: string;
  toolCallId: string;
  taint: TaintState;
  nowMs(): number;
  key: CryptoKey;
  replay: ApprovalReplayStore;
}
export async function executeBoundary(
  rawCall: ToolInvocation, context: BoundaryContext, registry: ToolClassifier,
  execute: (call: ToolInvocation) => Promise<JsonValue>, receipt?: unknown, adapters?: readonly MetaToolAdapter[],
  // Durable dispatchers rethrow uncertain outcomes instead of saving a completed failure.
  onExecutionError: (error: unknown) => ToolError = executionError,
): Promise<GateResult> {
  const failure = (error: ToolError, untrustedSource: boolean): GateResult => ({
    ok: false, error, untrustedSource, taint: resultTaint(context.taint, {value: null, untrustedSource}),
  });
  const parsed = ToolInvocationSchema.safeParse(rawCall);
  if (!parsed.success) return failure(toolError('schema', 'Invalid tool invocation.'), false);
  const call = structuredClone(parsed.data);
  const classification = classifyInvocation(call, registry, adapters);
  const decision = boundaryDecision(context.mode, classification, context.taint.tainted);
  if (decision === 'deny') return failure(toolError('policy-denied', 'Tool policy denied this action.'), false);
  const sideEffect = isSideEffect(classification.capabilities);
  if (decision === 'approve') {
    const binding = {runId: context.runId, toolCallId: context.toolCallId, tool: call.tool, argsHash: await argsHash(call.args)};
    const verified = await ApprovalReceipt.verify(receipt, binding, context.nowMs(), context.key, context.replay);
    if (!verified) return failure(context.taint.tainted && sideEffect
        ? toolError('taint-blocked', 'Untrusted content requires a fresh approval.')
        : toolError('approval-required', 'This action requires a fresh approval.'), false);
  }
  try {
    const result = {value: await execute(call), untrustedSource: classification.untrustedSource};
    return {ok: true, result, taint: resultTaint(context.taint, result)};
  } catch (error) {
    return failure(onExecutionError(error), classification.untrustedSource);
  }
}

function executionError(error: unknown): ToolError {
  if (error instanceof ToolBoundaryError) return error.detail;
  return toolError('upstream', 'Tool execution failed.');
}
