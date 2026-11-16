import {z} from 'zod';
import {WaitAgentsSchema, type SubagentTree, type WaitAgentsResult} from '@praxis/protocol';
import {toolError} from '../boundary/errors.js';
import {VerifiedHandoff, type SubagentWorkspacePort} from './handoff.js';
import {activeWaiter, waitTargets} from './wait-scope.js';

export async function waitAgents(input: SubagentTree, actorId: string, raw: unknown,
  timing: {startedAtMs: number; nowMs: number}, port: SubagentWorkspacePort): Promise<{tree: SubagentTree; result: WaitAgentsResult}> {
  const request = WaitAgentsSchema.parse(raw);
  z.object({startedAtMs: z.number().finite().nonnegative(), nowMs: z.number().finite().nonnegative()})
    .refine(t => t.nowMs >= t.startedAtMs).parse(timing);
  const tree = structuredClone(input);
  activeWaiter(tree, actorId);
  const nodes = waitTargets(tree, actorId, request.subagent_ids);
  for (const node of nodes) {
    if (node.status !== 'completed') continue;
    const proof = await VerifiedHandoff.verify(node.handoff, {
      id: node.id, revision: node.revision, requiredChecks: node.permissions.required_checks,
    }, port);
    if (!proof) {
      node.status = 'failed';
      node.handoff = null;
      node.error = toolError('schema', 'Unverified completion: restore the isolated artifacts and rerun required verification checks.');
    }
  }
  const finished = nodes.filter(n => ['completed', 'failed', 'cancelled'].includes(n.status));
  const ready = request.mode === 'any' ? finished.length > 0 : finished.length === nodes.length;
  const expired = timing.nowMs - timing.startedAtMs >= request.timeout_ms;
  return {tree, result: {
    status: ready ? 'ready' : expired ? 'timeout' : 'waiting',
    agents: (ready && request.mode === 'any' ? finished : nodes).map(n => ({
      subagent_id: n.id, status: n.status, handoff: n.handoff, error: n.error,
    })),
  }};
}
