import type {Message, ToolSpec} from '@praxis/protocol';
import {boundaryDecision} from './boundary/decision.js';
import {isSideEffect} from './boundary/policy.js';
import {decideTool, type ToolDecision} from './policy.js';
import type {AgentCheckpoint, AgentTool} from './types.js';

export const BOUNDARY_TEXT = {
  denied: 'This mode does not allow tools that send data to outside services.',
  policyDenied: 'Tool policy denied this call; correct the arguments or choose a permitted action.',
  egress: 'Sends model-chosen data to an outside service',
  tainted: 'Untrusted content was read in this conversation; this action needs a fresh approval.',
} as const;

export function runToolDecision(
  cp: AgentCheckpoint, tool: AgentTool, spec: ToolSpec, key: string, boundary = tool.boundary,
): ToolDecision {
  const tainted = cp.tainted;
  if (boundary) {
    const decision = boundaryDecision(cp.chat.mode, boundary, tainted);
    if (decision === 'deny') {
      return {decision: 'refuse', reason: boundary.decision === 'deny' ? BOUNDARY_TEXT.policyDenied : BOUNDARY_TEXT.denied};
    }
    if (decision === 'allow' && boundary.capabilities.includes('read') && !isSideEffect(boundary.capabilities)) {
      return {decision: 'allow', reason: ''};
    }
    return {decision: 'ask', reason: tainted ? BOUNDARY_TEXT.tainted : BOUNDARY_TEXT.egress};
  }
  const decision = decideTool(spec, cp.chat.mode, cp.policy, key);
  return tainted && decision.decision === 'ask' ? {...decision, reason: BOUNDARY_TEXT.tainted} : decision;
}

/** Prior untrusted tool results stay in context, so a resumed conversation starts tainted. */
export function historyTainted(messages: readonly Message[], tools: ReadonlyMap<string, AgentTool>): boolean {
  return messages.some(message => message.parts.some(part =>
    part.type === 'toolResult' && part.name !== undefined && tools.get(part.name)?.boundary?.untrustedSource === true));
}
