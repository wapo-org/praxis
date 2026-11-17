import type {SubagentTree, SubagentNode} from '@praxis/protocol';
import {canSee, nodeById, rejectSubagent} from './permissions.js';

export function waitTargets(tree: SubagentTree, actor: SubagentNode, ids: readonly string[]): SubagentNode[] {
  return ids.map(id => {
    const target = nodeById(tree, id);
    if (target.id === actor.id || !canSee(tree, actor, target)) return rejectSubagent('Wait target is outside visibility scope.');
    return target;
  });
}
