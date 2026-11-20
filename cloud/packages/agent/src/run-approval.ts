import {z} from 'zod';
import {
  JsonObjectSchema, ToolSpecSchema, type ApprovalBinding, type Approval, type Message, type ToolSpec,
} from '@praxis/protocol';
import {approvalPreview} from './approval-preview.js';
import {runToolDecision} from './run-boundary.js';
import {alwaysAllowKey, fingerprint} from './policy.js';
import type {AgentCheckpoint, AgentPorts, AgentTool, PendingCall} from './types.js';

export async function approvalBinding(runId: string, call: PendingCall): Promise<ApprovalBinding> {
  return {runId, toolCallId: call.id, tool: call.name, argsHash: await fingerprint(call.arguments)};
}

export async function prepareInvocation(cp: AgentCheckpoint, call: PendingCall, frozen: ToolSpec, live: AgentTool) {
  if (!JsonObjectSchema.safeParse(call.arguments).success) {
    return {ok: false, error: 'Tool arguments must be a valid JSON object.'} as const;
  }
  try {
    z.fromJSONSchema(frozen.inputSchema).parse(call.arguments);
  } catch {
    return {ok: false, error: 'Tool arguments do not match the frozen input schema.'} as const;
  }
  let boundary = live.boundary;
  if (live.classifyBoundary) {
    try {
      boundary = await live.classifyBoundary(call.arguments);
    } catch {
      return {ok: false, error: 'Tool policy classification failed.'} as const;
    }
  }
  let spec = live.spec;
  let key = `${await alwaysAllowKey(spec)}/traits:${await fingerprint({
    traits: [...spec.traits].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), boundary: boundary ?? null,
  })}`;
  if (live.classify) {
    try {
      const {traits, policyKey} = z.object({
        traits: ToolSpecSchema.shape.traits, policyKey: z.string().min(1).max(1000).optional(),
      }).parse(live.classify(call.arguments));
      spec = {...spec, traits};
      key += `/classification:${await fingerprint({
        traits: [...traits].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), policyKey: policyKey ?? null,
      })}`;
    } catch {
      return {ok: false, error: 'Tool policy classification failed.'} as const;
    }
  }
  return {ok: true, key, decision: runToolDecision(cp, live, spec, key, boundary), spec, boundary} as const;
}

export async function createPendingApproval(
  persist: NonNullable<AgentPorts['pendingApproval']>, cp: AgentCheckpoint, call: PendingCall,
  spec: ToolSpec, reason: string, key: string,
): Promise<Approval> {
  const binding = await approvalBinding(cp.run.id, call);
  const id = await fingerprint({binding, key});
  const preview = approvalPreview(call.arguments, spec.inputSchema);
  await persist(cp.userId, {...binding, id, preview});
  return {
    type: 'approval', id, callId: call.id, toolName: call.name, source: spec.source,
    arguments: preview, reason, title: `Allow ${spec.originalName ?? call.name}?`,
    ...(call.parentCallId && {parentCallId: call.parentCallId}),
  };
}

export function privateArguments(cp: AgentCheckpoint, tool: AgentTool | undefined): boolean {
  return !tool || tool.privateArguments === true || !!tool.classify || runToolDecision(cp, tool, tool.spec, '').decision !== 'allow';
}

export function publicToolMessage(cp: AgentCheckpoint, message: Message, tools: ReadonlyMap<string, AgentTool>): Message {
  const privateCalls = message.parts.filter(part =>
    part.type === 'toolCall' && privateArguments(cp, tools.get(part.name ?? '')));
  if (!privateCalls.length) return message;
  const parts = message.parts.map(part => privateCalls.includes(part) ? {...part, arguments: undefined} : part);
  return {...message, parts, raw: undefined};
}
