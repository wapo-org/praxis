import type {SubagentTree} from '@praxis/protocol';
import {VerifiedHandoff, type SubagentWorkspacePort} from './handoff.js';
import {nodeById, rejectSubagent} from './permissions.js';
import {reduceSubagents} from './reducer.js';

export interface VerifiedHandoffCommitPort {
  // PRA-114 compares the entire expected tree atomically, including lifecycle, revisions and parent cancellation.
  compareAndSwap(expected: SubagentTree, next: SubagentTree, digest: string): Promise<boolean>;
}

export async function completeSubagent(input: SubagentTree, id: string, record: unknown,
  workspace: SubagentWorkspacePort, store: VerifiedHandoffCommitPort): Promise<boolean> {
  const expected = structuredClone(input);
  const node = nodeById(expected, id);
  const proof = await VerifiedHandoff.verify(record, {
    id, revision: node.revision, requiredChecks: node.permissions.required_checks,
  }, workspace);
  if (!proof) return false;
  const next = reduceSubagents(expected, {type: 'complete', id, proof});
  return store.compareAndSwap(expected, next, proof.digest);
}

export async function prepareSubagent(input: SubagentTree, id: string, port: SubagentWorkspacePort): Promise<SubagentTree> {
  const node = nodeById(input, id);
  if (node.status !== 'spawning') return rejectSubagent('Isolation must be prepared before starting an agent.');
  await port.prepare(node.workspace);
  return reduceSubagents(input, {type: 'start', id});
}

// Cleanup acknowledgement follows a successful kill; adapters fence its commit against the current revision.
export async function cleanupSubagent(input: SubagentTree, id: string, port: SubagentWorkspacePort): Promise<SubagentTree> {
  const node = nodeById(input, id);
  if (node.status === 'cancelled') return input;
  if (node.status !== 'cancelling') return rejectSubagent('Only cancelling agents may be cleaned up.');
  let tree = input;
  for (const handle of node.handles) {
    await port.killHandle(node.workspace, handle);
    tree = reduceSubagents(tree, {type: 'cleanup', id, handle});
  }
  return reduceSubagents(tree, {type: 'finalize', id});
}
