import {expect, it} from 'vitest';
import fc from 'fast-check';
import {WaitAgentsResultSchema} from '@praxis/protocol';
import {boundaryDecision} from '../boundary/decision.js';
import {VerifiedHandoff} from './handoff.js';
import {nodeById} from './permissions.js';
import {reduceSubagents} from './reducer.js';
import {handoff, spawn, treeFixture, workspacePort} from './test-fixtures.js';
import {waitAgents} from './wait.js';

it('joins returned descendant taint monotonically before exposing wait results', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom('any', 'all'), fc.constantFrom('completed', 'failed', 'cancelled', 'running'),
    fc.boolean(), fc.boolean(), async (mode, status, expired, verificationPasses) => {
      let tree = spawn(spawn(spawn(treeFixture()), 'grandchild', 'child'), 'sibling');
      tree = reduceSubagents(tree, {type: 'taint', id: 'grandchild'});
      if (status === 'completed') {
        const proof = await VerifiedHandoff.verify(handoff('grandchild'), {
          id: 'grandchild', revision: 0, requiredChecks: ['typecheck'],
        }, workspacePort);
        tree = reduceSubagents(tree, {type: 'complete', id: 'grandchild', proof: proof!});
      } else if (status === 'failed') {
        tree = reduceSubagents(tree, {type: 'fail', id: 'grandchild', message: 'failed'});
      } else if (status === 'cancelled') {
        tree = reduceSubagents(tree, {type: 'stop', actorId: 'child', id: 'grandchild'});
        tree = reduceSubagents(tree, {type: 'finalize', id: 'grandchild'});
      } else {
        tree = reduceSubagents(tree, {type: 'start', id: 'grandchild'});
      }
      expect(nodeById(tree, 'root').tainted).toBe(false);
      const before = structuredClone(tree);
      const waited = await waitAgents(tree, 'root', {
        subagent_ids: ['grandchild', 'sibling'], mode, timeout_ms: 10,
      }, {startedAtMs: 0, nowMs: expired ? 10 : 0}, {
        ...workspacePort, verifyChecks: async () => [{id: 'typecheck', status: verificationPasses ? 'passed' : 'failed'}],
      });
      expect(tree).toEqual(before);
      expect(waited.tree.nodes.every(node => node.tainted)).toBe(true);
      expect(WaitAgentsResultSchema.parse(waited.result).tainted).toBe(true);
      expect(waited.result.agents.find(node => node.subagent_id === 'grandchild')?.tainted).toBe(true);
      expect(boundaryDecision('build', {
        decision: 'allow', capabilities: ['write'], untrustedSource: false,
      }, nodeById(waited.tree, 'root').tainted)).toBe('approve');
      const again = await waitAgents(waited.tree, 'root', {
        subagent_ids: ['sibling'], mode, timeout_ms: 0,
      }, {startedAtMs: 0, nowMs: 0}, workspacePort);
      expect(again.result.tainted).toBe(true);
      expect(nodeById(again.tree, 'root').tainted).toBe(true);
    }), {numRuns: 500});
});
