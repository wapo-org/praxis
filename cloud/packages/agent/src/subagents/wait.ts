import {z} from 'zod';
import {WaitAgentsSchema, WaitAgentsResultSchema, type SubagentTree, type SubagentNode, type WaitAgentsResult} from '@praxis/protocol';
import {canSee, joinSubagentTaint, nodeById, rejectSubagent, requireActive, setLifecycle, terminal} from './permissions.js';
import {toolError} from '../boundary/errors.js';
import {VerifiedHandoff, type SubagentWorkspacePort} from './handoff.js';

function waitTargets(tree: SubagentTree, actor: SubagentNode, ids: readonly string[]): SubagentNode[] {
  return ids.map(id => {
    const target = nodeById(tree, id);
    if (target.id === actor.id || !canSee(tree, actor, target)) return rejectSubagent('Wait target is outside visibility scope.');
    return target;
  });
}

export async function waitAgents(input: SubagentTree, actorId: string, raw: unknown,
  timing: {startedAtMs: number; nowMs: number}, port: SubagentWorkspacePort): Promise<{tree: SubagentTree; result: WaitAgentsResult}> {
  const request = WaitAgentsSchema.parse(raw);
  z.object({startedAtMs: z.number().finite().nonnegative(), nowMs: z.number().finite().nonnegative()})
    .refine(t => t.nowMs >= t.startedAtMs).parse(timing);
  const tree = structuredClone(input);
  const actor = nodeById(tree, actorId);
  requireActive(actor, 'Stopped parents cannot accept late child results.');
  const nodes = waitTargets(tree, actor, request.subagent_ids);
  for (const node of nodes) {
    if (node.status !== 'completed') continue;
    const proof = await VerifiedHandoff.verify(node.handoff, {
      id: node.id, revision: node.revision, requiredChecks: node.permissions.required_checks,
    }, port);
    if (!proof) {
      setLifecycle(node, {status: 'failed', handoff: null,
        error: toolError('schema', 'Unverified completion: restore the isolated artifacts and rerun required verification checks.')});
    }
  }
  const finished = nodes.filter(terminal);
  const ready = request.mode === 'any' ? finished.length > 0 : finished.length === nodes.length;
  const expired = timing.nowMs - timing.startedAtMs >= request.timeout_ms;
  const returned = ready && request.mode === 'any' ? finished : nodes;
  joinSubagentTaint(tree, actorId, ...returned);
  return {tree, result: WaitAgentsResultSchema.parse({
    status: ready ? 'ready' : expired ? 'timeout' : 'waiting', tainted: actor.tainted,
    agents: returned.map(n => ({
      subagent_id: n.id, status: n.status, tainted: n.tainted, handoff: n.handoff, error: n.error,
    })),
  })};
}
