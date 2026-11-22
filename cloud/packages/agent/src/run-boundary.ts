import {TAINT_SOURCE_CHARACTERS_MAX, type Message, type Run, type RunTaint, type ToolSpec} from '@praxis/protocol';
import {boundaryDecision} from './boundary/decision.js';
import {isSideEffect} from './boundary/policy.js';
import {decideTool, type ToolDecision} from './policy.js';
import type {AgentCheckpoint, AgentTool, ToolResult} from './types.js';

export const BOUNDARY_TEXT = {
  denied: 'This mode does not allow tools that send data to outside services.',
  policyDenied: 'Tool policy denied this call; correct the arguments or choose a permitted action.',
  egress: 'Sends model-chosen data to an outside service',
  tainted: 'Content this run read could steer this action, so it needs a fresh approval.',
} as const;

/** Tainted side effects need an exact-call approval: standing grants never apply (PRA-57). */
export function runToolDecision(
  cp: AgentCheckpoint, tool: AgentTool, spec: ToolSpec, key: string, boundary = tool.boundary,
): ToolDecision {
  const tainted = cp.run.taint !== undefined;
  if (boundary) {
    const decision = boundaryDecision(cp.chat.mode, boundary, tainted);
    if (decision === 'deny') {
      return {decision: 'refuse', reason: boundary.decision === 'deny' ? BOUNDARY_TEXT.policyDenied : BOUNDARY_TEXT.denied};
    }
    if (decision === 'allow') return {decision: 'allow', reason: ''};
    return {decision: 'ask', reason: tainted && isSideEffect(boundary.capabilities) ? BOUNDARY_TEXT.tainted : BOUNDARY_TEXT.egress};
  }
  const decision = decideTool(spec, cp.chat.mode, cp.policy, key);
  return tainted && decision.decision === 'ask' ? {...decision, reason: BOUNDARY_TEXT.tainted} : decision;
}

export function taintLabel(spec: ToolSpec): string {
  const label = spec.source.type === 'mcp' ? spec.source.serverName ?? 'a connector' : spec.originalName ?? spec.name;
  return label.replace(/_/g, ' ').slice(0, TAINT_SOURCE_CHARACTERS_MAX);
}

/** Connector (MCP) output and boundary-marked reads are attacker-controllable whatever the tool's name. */
export function untrustedTool(tool: AgentTool): boolean {
  return tool.boundary?.untrustedSource === true || tool.spec.source.type === 'mcp';
}

/** Monotone: the first source is kept and a tainted run never becomes clean. */
export function markTainted(run: Run, source: string, callId: string): void {
  run.taint ??= {tainted: true, source, callId};
}

/** The source that tainted this result, or undefined when it carries only trusted content. */
export function resultTaintSource(
  tool: AgentTool, spec: ToolSpec, result: ToolResult | undefined, nested: string | undefined,
): string | undefined {
  if (untrustedTool(tool) || result?.tainted === true) return taintLabel(spec);
  return nested;
}

/** Marks the stored call and ORs taint into the run before the result is exposed to the model. */
export function recordTaint(cp: AgentCheckpoint, callId: string, source: string | undefined): void {
  if (source === undefined) return;
  const entry = cp.calls[callId];
  if (entry) entry.taintSource = source;
  markTainted(cp.run, source, callId);
}

/** History taint comes only from the structural marks stored with tool results; tool names are never consulted. */
export function historyTaint(messages: readonly Message[]): RunTaint | undefined {
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'toolResult' && part.taintSource && part.callId) {
        return {tainted: true, source: part.taintSource, callId: part.callId};
      }
    }
  }
  return undefined;
}
