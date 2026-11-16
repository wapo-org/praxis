import type {SubagentTree, SubagentNode} from '@praxis/protocol';
import {canSee, nodeById, rejectSubagent, terminal} from './permissions.js';

export function activeWaiter(tree: SubagentTree, actorId: string): void {
  const actor = nodeById(tree, actorId);
  if (terminal(actor) || actor.status === 'cancelling') rejectSubagent('Stopped parents cannot accept late child results.');
}
export function waitTargets(tree: SubagentTree, actorId: string, ids: readonly string[]): SubagentNode[] {
  const actor = nodeById(tree, actorId);
  return ids.map(id => {
    const target = nodeById(tree, id);
    if (target.id === actor.id || !canSee(tree, actor, target)) return rejectSubagent('Wait target is outside visibility scope.');
    return target;
  });
}
