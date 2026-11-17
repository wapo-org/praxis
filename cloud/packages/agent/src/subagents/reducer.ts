import {
  SUBAGENT_LIMITS, SpawnAgentSchema, SubagentIdSchema, SubagentMessageSchema, SubagentPermissionsSchema,
  type SubagentTree, type SubagentNode, type SpawnAgent, type SubagentPermissions,
} from '@praxis/protocol';
import {canonical} from '../policy.js';
import {toolError} from '../boundary/errors.js';
import {VerifiedHandoff} from './handoff.js';
import {canSee, childPermissions, controls, isDescendant, joinSubagentTaint, nodeById, rejectSubagent, requireActive, setLifecycle, taintSubtree, terminal, workspaceFor} from './permissions.js';

export type SubagentEvent =
  | {type: 'spawn'; actorId: string; id: string; callId: string; request: Extract<SpawnAgent, {action: 'create'}>}
  | {type: 'start'; id: string}
  | {type: 'turn'; id: string}
  | {type: 'pause'; id: string}
  | {type: 'resume'; actorId: string; request: Extract<SpawnAgent, {action: 'resume'}>}
  | {type: 'configure'; actorId: string; id: string; name?: string; model?: string; effort?: 'low' | 'medium' | 'high'}
  | {type: 'send'; actorId: string; id: string; messageId: string; text: string}
  | {type: 'deliver'; id: string; messageId: string}
  | {type: 'handle'; id: string; handle: string}
  | {type: 'cleanup'; id: string; handle: string}
  | {type: 'stop'; actorId: string; id: string}
  | {type: 'finalize'; id: string}
  | {type: 'complete'; id: string; proof?: VerifiedHandoff}
  | {type: 'fail'; id: string; message: string}
  | {type: 'taint'; id: string};

export function createSubagentTree(rootId: string, permissions: SubagentPermissions, model: string): SubagentTree {
  const id = SubagentIdSchema.parse(rootId);
  return {nodes: [{
    id, parent_id: null, spawn_call_id: id, spawn_fingerprint: '', prompt: '', depth: 0,
    permissions: SubagentPermissionsSchema.parse(permissions), name: id, model, effort: 'medium',
    status: 'running', turns: 0, revision: 0, tainted: false, workspace: workspaceFor(id),
    handles: [], inbox: [], handoff: null, error: null,
  }]};
}
function noActiveChildren(tree: SubagentTree, node: SubagentNode): void {
  if (tree.nodes.some(n => isDescendant(tree, node.id, n.id) && !terminal(n))) {
    rejectSubagent('Clean up all descendants before finalizing the parent.');
  }
  if (node.handles.length) rejectSubagent('Clean up every sandbox handle before finalizing.');
}
function discardPending(node: SubagentNode): void {
  for (const message of node.inbox) if (message.disposition === 'pending') message.disposition = 'discarded';
}
function cancelBranch(tree: SubagentTree, id: string): void {
  for (const node of tree.nodes) {
    if ((node.id === id || isDescendant(tree, id, node.id)) && !terminal(node)) {
      setLifecycle(node, {status: 'cancelling', handoff: null, error: node.error});
      discardPending(node);
    }
  }
}
function ensureLiveParent(tree: SubagentTree, node: SubagentNode): void {
  if (node.parent_id !== null) requireActive(nodeById(tree, node.parent_id));
}
function joinParentTaint(tree: SubagentTree, node: SubagentNode): void {
  if (node.parent_id !== null) joinSubagentTaint(tree, node.parent_id, node);
}
function configure(node: SubagentNode, config: {name?: string; model?: string; effort?: 'low' | 'medium' | 'high'}): void {
  if (node.status !== 'waiting') rejectSubagent('Configuration changes require a waiting subagent.');
  if (config.name !== undefined) node.name = config.name;
  if (config.model !== undefined) node.model = config.model;
  if (config.effort !== undefined) node.effort = config.effort;
}

// The adapter serializes events and derives actorId from the authenticated workflow, never model arguments.
export function reduceSubagents(input: SubagentTree, event: SubagentEvent): SubagentTree {
  const tree = structuredClone(input);
  if (event.type === 'spawn') {
    const parent = nodeById(tree, event.actorId);
    requireActive(parent);
    if (!parent.permissions.tools.includes('spawn_agent')) return rejectSubagent('Spawn permission is not granted to this agent.');
    const request = SpawnAgentSchema.parse(event.request);
    if (request.action !== 'create') return rejectSubagent('Expected a create request.');
    const existing = tree.nodes.find(n => n.parent_id === parent.id && n.spawn_call_id === event.callId);
    if (existing) {
      if (existing.id !== event.id || existing.spawn_fingerprint !== canonical(request)) rejectSubagent('Conflicting spawn retry.');
      return tree;
    }
    SubagentIdSchema.parse(event.id);
    if (!event.callId || tree.nodes.some(n => n.id === event.id)) return rejectSubagent('Subagent ids and spawn call ids must be unique.');
    if (tree.nodes.filter(n => n.parent_id === parent.id).length >= SUBAGENT_LIMITS.CHILDREN_MAX) {
      return rejectSubagent('The per-parent child limit is reached.');
    }
    const permissions = childPermissions(parent, request);
    tree.nodes.push({
      id: event.id, parent_id: parent.id, spawn_call_id: event.callId, spawn_fingerprint: canonical(request), prompt: request.prompt, depth: parent.depth + 1,
      permissions, name: request.name ?? event.id, model: request.model ?? parent.model, effort: request.effort ?? parent.effort,
      status: 'spawning', turns: 0, revision: 0, tainted: parent.tainted, workspace: workspaceFor(event.id),
      inbox: [], handles: [], handoff: null, error: null,
    });
    return tree;
  }
  if (event.type === 'resume') {
    const request = SpawnAgentSchema.parse(event.request);
    if (request.action !== 'resume') return rejectSubagent('Expected a resume request.');
    const actor = nodeById(tree, event.actorId);
    const node = nodeById(tree, request.subagent_id);
    requireActive(actor);
    if (!controls(actor, node)) return rejectSubagent('Only the parent may resume a child.');
    if (!['waiting', 'completed', 'failed'].includes(node.status)) return rejectSubagent('Only waiting or finished agents may resume.');
    setLifecycle(node, {status: 'waiting', handoff: null, error: null});
    configure(node, request);
    if (node.turns >= node.permissions.turn_cap) return rejectSubagent('The turn cap cannot be reset by resume.');
    node.revision++;
    setLifecycle(node, {status: 'running', handoff: null, error: null});
    return tree;
  }
  const node = nodeById(tree, event.id);
  switch (event.type) {
    case 'start':
      if (node.status !== 'spawning') return rejectSubagent('Only a spawning child may start.');
      ensureLiveParent(tree, node);
      setLifecycle(node, {status: 'running', handoff: null, error: null});
      break;
    case 'turn':
      if (node.status !== 'running') return rejectSubagent('Only running agents may consume turns.');
      ensureLiveParent(tree, node);
      if (node.turns >= node.permissions.turn_cap) {
        cancelBranch(tree, node.id);
        setLifecycle(node, {status: 'cancelling', handoff: null,
          error: toolError('budget', 'Subagent turn cap exhausted; close this agent or start a separately budgeted task.')});
      } else {
        node.turns++;
      }
      break;
    case 'pause':
      if (node.status !== 'running') return rejectSubagent('Only running agents may wait.');
      setLifecycle(node, {status: 'waiting', handoff: null, error: null});
      break;
    case 'configure': {
      const actor = nodeById(tree, event.actorId);
      requireActive(actor);
      if (!controls(actor, node)) return rejectSubagent('Only the parent may configure a child.');
      configure(node, event);
      break;
    }
    case 'send': {
      const actor = nodeById(tree, event.actorId);
      requireActive(actor);
      requireActive(node);
      if (!canSee(tree, actor, node)) return rejectSubagent('The target is outside the sender visibility scope.');
      const existing = node.inbox.find(m => m.id === event.messageId);
      if (existing) {
        if (existing.sender_id !== actor.id || existing.text !== event.text) return rejectSubagent('Conflicting inbox retry.');
        break;
      }
      const message = SubagentMessageSchema.parse({id: event.messageId, sender_id: actor.id,
        sequence: node.inbox.length + 1, text: event.text, tainted: actor.tainted, disposition: 'pending'});
      node.inbox.push(message);
      joinSubagentTaint(tree, node.id, message);
      break;
    }
    case 'deliver': {
      requireActive(node);
      const message = node.inbox.find(m => m.id === event.messageId);
      if (!message || message.disposition === 'discarded') return rejectSubagent('Message is not deliverable.');
      if (node.inbox.some(m => m.sequence < message.sequence && m.disposition === 'pending')) {
        return rejectSubagent('Inbox messages must be delivered in order.');
      }
      joinSubagentTaint(tree, node.id, message);
      message.disposition = 'delivered';
      break;
    }
    case 'handle':
      requireActive(node);
      if (!event.handle || tree.nodes.some(n => n.handles.includes(event.handle))) return rejectSubagent('Handle is already owned.');
      node.handles.push(event.handle);
      break;
    case 'cleanup':
      node.handles = node.handles.filter(h => h !== event.handle);
      break;
    case 'stop': {
      const actor = nodeById(tree, event.actorId);
      if (actor.id !== node.id && !controls(actor, node)) return rejectSubagent('Only self or parent may close an agent.');
      cancelBranch(tree, node.id);
      break;
    }
    case 'finalize':
      if (node.status !== 'cancelling') return rejectSubagent('Only cancelling agents may finalize cancellation.');
      noActiveChildren(tree, node);
      setLifecycle(node, {status: 'cancelled', handoff: null, error: node.error});
      joinParentTaint(tree, node);
      break;
    case 'complete':
      requireActive(node);
      ensureLiveParent(tree, node);
      noActiveChildren(tree, node);
      if (!VerifiedHandoff.valid(event.proof, node.id, node.revision, node.permissions.required_checks)) {
        setLifecycle(node, {status: 'failed', handoff: null,
          error: toolError('schema', 'Unverified completion: recompute artifact hashes and rerun required checks before handing off.')});
      } else {
        setLifecycle(node, {status: 'completed', handoff: event.proof!.record, error: null});
      }
      discardPending(node);
      joinParentTaint(tree, node);
      break;
    case 'fail':
      requireActive(node);
      noActiveChildren(tree, node);
      setLifecycle(node, {status: 'failed', handoff: null, error: toolError('upstream', event.message)});
      discardPending(node);
      joinParentTaint(tree, node);
      break;
    case 'taint':
      requireActive(node);
      taintSubtree(tree, node.id);
      break;
  }
  return tree;
}
