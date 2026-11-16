import {SUBAGENT_WORKSPACE_ROOT, SubagentIdSchema, type SubagentNode, type SubagentTree, type SpawnAgent} from '@praxis/protocol';
import {ToolBoundaryError, toolError} from '../boundary/errors.js';

export function rejectSubagent(message: string): never {
  throw new ToolBoundaryError(toolError('policy-denied', message));
}
export function workspaceFor(id: string): string {
  return `${SUBAGENT_WORKSPACE_ROOT}/${SubagentIdSchema.parse(id)}`;
}
export function narrowTools(parent: readonly string[], requested: readonly string[]): string[] {
  if (new Set(requested).size !== requested.length || requested.some(tool => !parent.includes(tool))) {
    return rejectSubagent('A child tool set must be a subset of its parent.');
  }
  return [...requested];
}
export function childPermissions(parent: SubagentNode, request: Extract<SpawnAgent, {action: 'create'}>): SubagentNode['permissions'] {
  if (parent.depth >= parent.permissions.max_depth) return rejectSubagent('The delegation depth limit is reached.');
  if (request.turn_cap > parent.permissions.turn_cap || request.visibility_depth > parent.permissions.visibility_depth ||
    (request.discover_siblings && !parent.permissions.discover_siblings)) {
    return rejectSubagent('Child limits and visibility may only narrow parent permissions.');
  }
  const tools = narrowTools(parent.permissions.tools, request.tools);
  return {...parent.permissions, tools, turn_cap: request.turn_cap,
    visibility_depth: request.visibility_depth, discover_siblings: request.discover_siblings};
}
export function nodeById(tree: SubagentTree, id: string): SubagentNode {
  const node = tree.nodes.find(n => n.id === id);
  if (!node) return rejectSubagent('Unknown subagent address.');
  return node;
}
export function isDescendant(tree: SubagentTree, ancestorId: string, id: string): boolean {
  let node = nodeById(tree, id);
  while (node.parent_id !== null) {
    if (node.parent_id === ancestorId) return true;
    node = nodeById(tree, node.parent_id);
  }
  return false;
}
function lineage(tree: SubagentTree, node: SubagentNode): string[] {
  const ids = [node.id];
  while (node.parent_id !== null) {
    node = nodeById(tree, node.parent_id);
    ids.push(node.id);
  }
  return ids;
}
export function canSee(tree: SubagentTree, actor: SubagentNode, target: SubagentNode): boolean {
  if (actor.id === target.id || target.parent_id === actor.id || actor.parent_id === target.id) return true;
  const ownBranch = isDescendant(tree, actor.id, target.id);
  if (!ownBranch && !actor.permissions.discover_siblings) return false;
  const a = lineage(tree, actor);
  const b = lineage(tree, target);
  const common = a.find(id => b.includes(id));
  if (!common) return false;
  return a.indexOf(common) + b.indexOf(common) <= actor.permissions.visibility_depth;
}
export function discoverAgents(tree: SubagentTree, actorId: string): Pick<SubagentNode, 'id' | 'parent_id' | 'name' | 'status'>[] {
  const actor = nodeById(tree, actorId);
  return tree.nodes.filter(n => canSee(tree, actor, n)).map(n => ({id: n.id, parent_id: n.parent_id, name: n.name, status: n.status}));
}
export function controls(actor: SubagentNode, target: SubagentNode): boolean {
  return actor.id === target.parent_id;
}
export function terminal(node: SubagentNode): boolean {
  return ['completed', 'failed', 'cancelled'].includes(node.status);
}
