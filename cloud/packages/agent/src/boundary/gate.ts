import {ToolInvocationSchema, type ToolInvocation, type ToolError, type JsonValue, type Mode} from '@praxis/protocol';
import {ApprovalReceipt, argsHash, type ApprovalReplayStore} from './receipt.js';
import {classifyInvocation, isSideEffect, resultTaint, type ToolClassifier, type MetaToolAdapter, type TaintState, type BoundaryResult} from './policy.js';
import {boundaryDecision} from './decision.js';
import {toolError} from './errors.js';

export type GateResult = {ok: true; result: BoundaryResult; taint: TaintState} | {ok: false; error: ToolError};
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
): Promise<GateResult> {
  const parsed = ToolInvocationSchema.safeParse(rawCall);
  if (!parsed.success) return {ok: false, error: toolError('schema', 'Invalid tool invocation.')};
  const call = structuredClone(parsed.data);
  const classification = classifyInvocation(call, registry, adapters);
  const decision = boundaryDecision(context.mode, classification, context.taint.tainted);
  if (decision === 'deny') return {ok: false, error: toolError('policy-denied', 'Tool policy denied this action.')};
  const sideEffect = isSideEffect(classification.capabilities);
  if (decision === 'approve') {
    const binding = {runId: context.runId, toolCallId: context.toolCallId, tool: call.tool, argsHash: await argsHash(call.args)};
    const verified = await ApprovalReceipt.verify(receipt, binding, context.nowMs(), context.key, context.replay);
    if (!verified) return {
      ok: false,
      error: context.taint.tainted && sideEffect
        ? toolError('taint-blocked', 'Untrusted content requires a fresh approval.')
        : toolError('approval-required', 'This action requires a fresh approval.'),
    };
  }
  const result = {value: await execute(call), untrustedSource: classification.untrustedSource};
  return {ok: true, result, taint: resultTaint(context.taint, result)};
}
