import {z} from 'zod';
import {
  SUBAGENT_TOOL_NAMES, SpawnAgentSchema, MessageAgentSchema, WaitAgentsSchema, CloseAgentSchema,
  SubagentToolCallSchema, JsonObjectSchema, WaitAgentsResultSchema,
  SubagentAddressResultSchema, SendAgentMessageResultSchema, CloseAgentResultSchema, DiscoverAgentsResultSchema,
  type SubagentToolCall, type SubagentToolResult, type SubagentTree, type WaitAgents,
} from '@praxis/protocol';
import type {AgentTool, ToolContext} from '../types.js';
import type {ToolClassification, ToolClassifier} from '../boundary/policy.js';
import {ToolBoundaryError, toolError} from '../boundary/errors.js';
import {canSee, controls, discoverAgents, joinSubagentTaint, narrowTools, nodeById, rejectSubagent, requireActive} from './permissions.js';
import {reduceSubagents} from './reducer.js';

export const SUBAGENT_TOOL_DESCRIPTIONS = {
  spawn_agent: 'Create an isolated child with explicit grants, or resume an addressed child within its lifetime budget.',
  message_agent: 'Send a coordination message, configure a waiting direct child, or discover visible metadata.',
  wait_agents: 'Wait for verified any/all addressed results until a durable deadline; timeout leaves work running.',
  close_agent: 'Cancel self or a direct child and its active subtree; cleanup is acknowledged separately.',
} as const;
export interface DelegationTool {
  name: string;
  classification: ToolClassification;
  usesSecrets: boolean;
  confinedToChildWorkspace: boolean;
  explicitGrant?: boolean;
}
export interface DelegationModel {
  id: string;
  tools: boolean;
  supportedEfforts: readonly string[];
}
export interface SubagentTransaction {
  tree: SubagentTree;
  actorId: string;
  childId: string;
  messageId: string;
  models: readonly DelegationModel[];
  tools: readonly DelegationTool[];
}
export type SubagentTransition = {tree: SubagentTree; result: SubagentToolResult | null; tainted: boolean};
// The adapter binds actor/tenant, fences retries, and commits state plus outbox before returning any result.
export interface SubagentHarnessPort {
  transact(context: ToolContext, transition: (state: SubagentTransaction) => SubagentTransition): Promise<SubagentTransition>;
  // Persist taint joins and reverify handoffs before exposure; durable wait IDs/deadlines belong to the adapter.
  wait(context: ToolContext, request: WaitAgents): Promise<z.infer<typeof WaitAgentsResultSchema>>;
}

export function defaultChildTools(parent: readonly string[], tools: readonly DelegationTool[]): string[] {
  return tools.filter(tool => parent.includes(tool.name) && !tool.usesSecrets && !tool.classification.destructive &&
    !tool.classification.untrustedWrite && tool.classification.decision === 'allow' &&
    !tool.classification.capabilities.includes('external-egress') &&
    (tool.classification.capabilities.every(c => c === 'read') || tool.confinedToChildWorkspace)).map(tool => tool.name);
}
function validateModel(state: SubagentTransaction, model: string, effort: string, tools: readonly string[]): void {
  const configured = state.models.find(entry => entry.id === model);
  if (!configured) rejectSubagent(`Model ${model} is unavailable; choose an authorized configured model.`);
  if (tools.length && !configured.tools) rejectSubagent(`Model ${model} does not support tools; choose a tool-capable model.`);
  if (!configured.supportedEfforts.includes(effort)) {
    rejectSubagent(`Effort ${effort} is unsupported for ${model}; choose one of: ${configured.supportedEfforts.join(', ')}.`);
  }
}
function resultSchema(call: SubagentToolCall): z.ZodType<SubagentToolResult> {
  switch (call.tool) {
    case 'spawn_agent': return SubagentAddressResultSchema;
    case 'message_agent':
      switch (call.args.action) {
        case 'send': return SendAgentMessageResultSchema;
        case 'configure': return SubagentAddressResultSchema;
        case 'discover': return DiscoverAgentsResultSchema;
      }
      break;
    case 'close_agent': return CloseAgentResultSchema;
    case 'wait_agents': return WaitAgentsResultSchema;
  }
}
function transition(state: SubagentTransaction, call: SubagentToolCall, context: ToolContext): SubagentTransition {
  let tree = structuredClone(state.tree);
  const actor = nodeById(tree, state.actorId);
  if (call.tool !== 'close_agent') requireActive(actor);
  if (!actor.permissions.tools.includes(call.tool)) rejectSubagent('Collaboration tool is outside the actor grant.');
  joinSubagentTaint(tree, actor.id, {tainted: context.tainted ?? false});
  let result: SubagentToolResult | null;
  if (call.tool === 'spawn_agent') {
    const request = call.args;
    if (request.action === 'create') {
      narrowTools(actor.permissions.tools, request.tools);
      const allowed = defaultChildTools(actor.permissions.tools, state.tools);
      const explicit = state.tools.filter(tool => tool.explicitGrant &&
        (tool.classification.capabilities.every(c => c === 'read' || c === 'external-egress') ||
          tool.confinedToChildWorkspace)).map(tool => tool.name);
      narrowTools([...allowed, ...explicit], request.tools);
      validateModel(state, request.model ?? actor.model, request.effort ?? actor.effort, request.tools);
      tree = reduceSubagents(tree, {type: 'spawn', actorId: actor.id, id: state.childId, callId: context.callId, request});
      result = {subagent_id: state.childId};
    } else {
      const child = nodeById(tree, request.subagent_id);
      if (!controls(actor, child)) rejectSubagent('Only the direct parent may configure or resume a child.');
      validateModel(state, request.model ?? child.model, request.effort ?? child.effort, child.permissions.tools);
      tree = reduceSubagents(tree, {type: 'resume', actorId: actor.id, request});
      result = {subagent_id: child.id};
    }
  } else if (call.tool === 'message_agent') {
    const request = call.args;
    if (request.action === 'discover') {
      const discovered = discoverAgents(tree, actor.id);
      tree = discovered.tree;
      result = discovered.result;
    } else if (request.action === 'send') {
      tree = reduceSubagents(tree, {type: 'send', actorId: actor.id, id: request.subagent_id,
        messageId: state.messageId, text: request.message});
      result = {subagent_id: request.subagent_id, message_id: state.messageId};
    } else {
      const child = nodeById(tree, request.subagent_id);
      if (!controls(actor, child)) rejectSubagent('Only the direct parent may configure or resume a child.');
      validateModel(state, request.model ?? child.model, request.effort ?? child.effort, child.permissions.tools);
      tree = reduceSubagents(tree, {type: 'configure', actorId: actor.id, id: child.id, ...request});
      result = {subagent_id: child.id};
    }
  } else if (call.tool === 'close_agent') {
    tree = reduceSubagents(tree, {type: 'stop', actorId: actor.id, id: call.args.subagent_id});
    result = {subagent_id: call.args.subagent_id, status: nodeById(tree, call.args.subagent_id).status};
  } else {
    for (const id of call.args.subagent_ids) {
      const target = nodeById(tree, id);
      if (id === actor.id || !canSee(tree, actor, target)) rejectSubagent('Wait target is outside visibility scope.');
    }
    result = null;
  }
  return {tree, result: result === null ? null : resultSchema(call).parse(result), tainted: nodeById(tree, actor.id).tainted};
}

export function createSubagentHarness(port: SubagentHarnessPort): {tools: AgentTool[]; registry: ToolClassifier} {
  const schemas = {spawn_agent: SpawnAgentSchema, message_agent: MessageAgentSchema,
    wait_agents: WaitAgentsSchema, close_agent: CloseAgentSchema};
  return {
    tools: SUBAGENT_TOOL_NAMES.map(name => ({
      spec: {type: 'tool.spec', name, description: SUBAGENT_TOOL_DESCRIPTIONS[name], source: {type: 'builtin'},
        traits: ['readOnly'], inputSchema: JsonObjectSchema.parse(z.toJSONSchema(schemas[name], {io: 'input'}))},
      async execute(args, context) {
        let tainted = context.tainted ?? false;
        const parsed = SubagentToolCallSchema.safeParse({tool: name, args});
        if (!parsed.success) {
          const error = toolError('schema', 'Invalid subagent arguments; use unique tool names and target IDs.');
          return {content: [JsonObjectSchema.parse(error)], isError: true, error, tainted};
        }
        const call = parsed.data;
        try {
          const committed = await port.transact(context, state => transition(state, call, context));
          tainted ||= committed.tainted;
          const value = call.tool === 'wait_agents'
            ? WaitAgentsResultSchema.parse(await port.wait(context, call.args)) : resultSchema(call).parse(committed.result);
          tainted ||= 'tainted' in value && value.tainted;
          return {content: [{type: 'text', text: JSON.stringify(value)}], isError: false, tainted};
        } catch (error) {
          if (!(error instanceof ToolBoundaryError)) throw error;
          return {content: [JsonObjectSchema.parse(error.detail)], isError: true, error: error.detail, tainted};
        }
      },
    })),
    registry: {classify(call) {
      if (!SUBAGENT_TOOL_NAMES.some(name => name === call.tool)) return undefined;
      return {capabilities: ['read'], decision: 'allow', untrustedSource: false};
    }},
  };
}
