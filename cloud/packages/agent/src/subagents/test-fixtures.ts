import {SUBAGENT_LIMITS, type SpawnAgent, type SubagentTree} from '@praxis/protocol';
import {createSubagentTree, reduceSubagents} from './reducer.js';
import type {SubagentWorkspacePort} from './handoff.js';

export const createRequest: Extract<SpawnAgent, {action: 'create'}> = {
  action: 'create', prompt: 'Build the isolated task', tools: ['read_file', 'spawn_agent'],
  visibility_depth: 4, discover_siblings: true, turn_cap: 3,
};
export function treeFixture(): SubagentTree {
  return createSubagentTree('root', {
    tools: ['read_file', 'edit_file', 'spawn_agent'], max_depth: SUBAGENT_LIMITS.DEPTH_MAX,
    visibility_depth: 4, discover_siblings: true, turn_cap: 3, required_checks: ['typecheck'],
  }, 'test-model');
}
export function spawn(tree: SubagentTree, id = 'child', parentId = 'root'): SubagentTree {
  return reduceSubagents(tree, {type: 'spawn', actorId: parentId, id, callId: id, request: createRequest});
}
export const bytes = new TextEncoder().encode('artifact');
export const workspacePort: SubagentWorkspacePort = {
  prepare: async () => {}, readArtifact: async () => bytes,
  verifyChecks: async (_root, ids) => ids.map(id => ({id, status: 'passed'})), killHandle: async () => {},
};
export function handoff(id = 'child', revision = 0) {
  return {subagent_id: id, revision, status: 'completed' as const, artifacts: [],
    checks: [{id: 'typecheck', status: 'passed' as const}], diff_summary: 'Added a verified artifact'};
}
