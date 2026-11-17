import type {Message, ToolSpec} from '@praxis/protocol';
import {boundaryDecision} from './boundary/decision.js';
import {decideTool, sourceKey, type ToolDecision} from './policy.js';
import type {AgentCheckpoint, AgentTool} from './types.js';

export const BOUNDARY_TEXT = {
  denied: 'This mode does not allow tools that send data to outside services.',
  egress: 'Sends model-chosen data to an outside service',
  tainted: 'Untrusted content was read in this conversation; this action needs a fresh approval.',
} as const;

/** PRA-76 boundary for classified tools; legacy tools keep decideTool but lose implicit allows once the run is tainted. */
export function runToolDecision(cp: AgentCheckpoint, tool: AgentTool, spec: ToolSpec, key: string): ToolDecision {
  const tainted = cp.tainted;
  if (tool.boundary) {
    const decision = boundaryDecision(cp.chat.mode, tool.boundary, tainted);
    if (decision === 'deny') return {decision: 'refuse', reason: BOUNDARY_TEXT.denied};
    if (decision === 'allow') return {decision: 'allow', reason: ''};
    // A durable always-allow never substitutes for the fresh approval taint requires.
    if (!tainted && cp.policy.alwaysAllow.includes(key)) return {decision: 'allow', reason: ''};
    return {decision: 'ask', reason: tainted ? BOUNDARY_TEXT.tainted : BOUNDARY_TEXT.egress};
  }
  const legacy = decideTool(spec, cp.chat.mode, cp.policy, key);
  if (!tainted || legacy.decision !== 'allow' || readOnly(spec, cp)) return legacy;
  return {decision: 'ask', reason: BOUNDARY_TEXT.tainted};
}

function readOnly(spec: ToolSpec, cp: AgentCheckpoint): boolean {
  const trusted = spec.source.type !== 'mcp' || cp.policy.trustedSources.includes(sourceKey(spec));
  return trusted && spec.traits.includes('readOnly') && !spec.traits.includes('destructive');
}

/** Prior untrusted tool results stay in context, so a resumed conversation starts tainted. */
export function historyTainted(messages: readonly Message[], tools: ReadonlyMap<string, AgentTool>): boolean {
  return messages.some(message => message.parts.some(part =>
    part.type === 'toolResult' && part.name !== undefined && tools.get(part.name)?.boundary?.untrustedSource === true));
}
