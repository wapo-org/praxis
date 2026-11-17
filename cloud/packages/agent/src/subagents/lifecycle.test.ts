import {expect, it} from 'vitest';
import {reduceSubagents} from './reducer.js';
import {VerifiedHandoff} from './handoff.js';
import {waitAgents} from './wait.js';
import {nodeById} from './permissions.js';
import {treeFixture, spawn, createRequest, workspacePort, handoff} from './test-fixtures.js';

it('deduplicates spawn by parent/call and rejects changed retry arguments', () => {
  const tree = spawn(treeFixture());
  expect(spawn(tree)).toEqual(tree);
  expect(() => reduceSubagents(tree, {type: 'spawn', actorId: 'root', id: 'child', callId: 'child',
    request: {...createRequest, tools: []}})).toThrow('Conflicting');
  expect(() => spawn(tree, 'child', 'child')).toThrow();
});
it('starts, pauses, configures and resumes addressed agents without resetting turns', () => {
  let tree = spawn(treeFixture());
  tree = reduceSubagents(tree, {type: 'start', id: 'child'});
  tree = reduceSubagents(tree, {type: 'turn', id: 'child'});
  tree = reduceSubagents(tree, {type: 'pause', id: 'child'});
  tree = reduceSubagents(tree, {type: 'configure', actorId: 'root', id: 'child', name: 'renamed'});
  tree = reduceSubagents(tree, {type: 'resume', actorId: 'root', request: {action: 'resume', subagent_id: 'child', model: 'other', effort: 'high'}});
  expect(nodeById(tree, 'child')).toMatchObject({status: 'running', turns: 1, revision: 1, name: 'renamed', model: 'other', effort: 'high'});
  expect(nodeById(tree, 'root').model).toBe('test-model');
});
it('enforces a lifetime turn cap and caps fanout', () => {
  let tree = reduceSubagents(spawn(treeFixture()), {type: 'start', id: 'child'});
  for (let i = 0; i < 4; i++) tree = reduceSubagents(tree, {type: 'turn', id: 'child'});
  expect(nodeById(tree, 'child')).toMatchObject({status: 'cancelling', turns: 3, error: {code: 'budget'}});
  expect(() => reduceSubagents(tree, {type: 'resume', actorId: 'root', request: {action: 'resume', subagent_id: 'child'}})).toThrow();
  tree = spawn(spawn(spawn(tree, 'two'), 'three'), 'four');
  expect(() => spawn(tree, 'five')).toThrow('child limit');
});
it('cascades Stop, fences late results and cleans descendants before parents', () => {
  let tree = spawn(spawn(treeFixture()), 'grandchild', 'child');
  tree = reduceSubagents(tree, {type: 'handle', id: 'grandchild', handle: 'process'});
  tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'root'});
  expect(tree.nodes.every(n => n.status === 'cancelling')).toBe(true);
  expect(() => reduceSubagents(tree, {type: 'complete', id: 'child'})).toThrow();
  expect(() => reduceSubagents(tree, {type: 'finalize', id: 'root'})).toThrow('descendants');
  expect(() => reduceSubagents(tree, {type: 'finalize', id: 'grandchild'})).toThrow('handle');
  tree = reduceSubagents(tree, {type: 'cleanup', id: 'grandchild', handle: 'process'});
  for (const id of ['grandchild', 'child', 'root']) tree = reduceSubagents(tree, {type: 'finalize', id});
  expect(tree.nodes.every(n => n.status === 'cancelled' && !n.handles.length)).toBe(true);
  expect(reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'root'})).toEqual(tree);
});
it('delivers messages in order exactly once and discards only pending messages on Stop', () => {
  let tree = spawn(treeFixture());
  for (const messageId of ['a', 'b']) tree = reduceSubagents(tree, {type: 'send', actorId: 'root', id: 'child', messageId, text: messageId});
  expect(() => reduceSubagents(tree, {type: 'deliver', id: 'child', messageId: 'b'})).toThrow('order');
  for (let i = 0; i < 2; i++) tree = reduceSubagents(tree, {type: 'deliver', id: 'child', messageId: 'a'});
  tree = reduceSubagents(tree, {type: 'send', actorId: 'root', id: 'child', messageId: 'a', text: 'a'});
  expect(nodeById(tree, 'child').inbox).toHaveLength(2);
  tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'child'});
  expect(nodeById(tree, 'child').inbox.map(m => m.disposition)).toEqual(['delivered', 'discarded']);
});
it('requires a verified handoff to complete and propagates child taint', async () => {
  let tree = spawn(treeFixture());
  tree = reduceSubagents(tree, {type: 'taint', id: 'child'});
  const proof = await VerifiedHandoff.verify(handoff(), {id: 'child', revision: 0, requiredChecks: ['typecheck']}, workspacePort);
  expect(proof).not.toBeNull();
  tree = reduceSubagents(tree, {type: 'complete', id: 'child', proof: proof!});
  expect(nodeById(tree, 'child').status).toBe('completed');
  expect(nodeById(tree, 'root').tainted).toBe(true);
  expect(nodeById(reduceSubagents(spawn(treeFixture()), {type: 'complete', id: 'child'}), 'child')).toMatchObject({status: 'failed', error: {code: 'schema'}});
});
it('wait supports any/all and explicit timeout without cancelling children', async () => {
  let tree = spawn(spawn(treeFixture()), 'second');
  tree = reduceSubagents(tree, {type: 'complete', id: 'child'});
  const args = {subagent_ids: ['child', 'second'], mode: 'any', timeout_ms: 10};
  expect((await waitAgents(tree, 'root', args, {startedAtMs: 0, nowMs: 0}, workspacePort)).result.status).toBe('ready');
  expect((await waitAgents(tree, 'root', {...args, mode: 'all'}, {startedAtMs: 0, nowMs: 0}, workspacePort)).result.status).toBe('waiting');
  const timed = await waitAgents(tree, 'root', {...args, mode: 'all'}, {startedAtMs: 0, nowMs: 10}, workspacePort);
  expect(timed.result.status).toBe('timeout');
  expect(nodeById(timed.tree, 'second').status).toBe('spawning');
});
it('wait rejects unverified completed results and refuses stopped parent writes', async () => {
  const tree = spawn(treeFixture());
  nodeById(tree, 'child').status = 'completed';
  nodeById(tree, 'child').handoff = handoff();
  const result = await waitAgents(tree, 'root', {subagent_ids: ['child'], mode: 'all', timeout_ms: 0}, {startedAtMs: 0, nowMs: 0},
    {...workspacePort, verifyChecks: async () => [{id: 'typecheck', status: 'failed'}]});
  expect(result.result.agents[0]).toMatchObject({status: 'failed', error: {code: 'schema', remediation: expect.any(String)}});
  const stopped = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'root'});
  await expect(waitAgents(stopped, 'root', {subagent_ids: ['child'], mode: 'all', timeout_ms: 0}, {startedAtMs: 0, nowMs: 0}, workspacePort)).rejects.toThrow('late');
});
it('resumes a completed agent with a fresh revision and a preserved lifetime budget', async () => {
  let tree = spawn(treeFixture());
  const proof = await VerifiedHandoff.verify(handoff(), {id: 'child', revision: 0, requiredChecks: ['typecheck']}, workspacePort);
  tree = reduceSubagents(tree, {type: 'complete', id: 'child', proof: proof!});
  tree = reduceSubagents(tree, {type: 'resume', actorId: 'root', request: {action: 'resume', subagent_id: 'child'}});
  expect(nodeById(tree, 'child')).toMatchObject({status: 'running', revision: 1, turns: 0, handoff: null});
  tree = reduceSubagents(tree, {type: 'complete', id: 'child', proof: proof!});
  expect(nodeById(tree, 'child').status).toBe('failed');
});
it('workspace preparation and cleanup fail closed through the injected port', async () => {
  const {prepareSubagent, cleanupSubagent} = await import('./workspace.js');
  let tree = spawn(treeFixture());
  await expect(prepareSubagent(tree, 'child', {...workspacePort, prepare: async () => {throw new Error('isolation unavailable');}})).rejects.toThrow('isolation');
  expect(nodeById(tree, 'child').status).toBe('spawning');
  tree = await prepareSubagent(tree, 'child', workspacePort);
  tree = reduceSubagents(tree, {type: 'handle', id: 'child', handle: 'job'});
  tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'child'});
  await expect(cleanupSubagent(tree, 'child', {...workspacePort, killHandle: async () => {throw new Error('kill failed');}})).rejects.toThrow('kill');
  expect(nodeById(tree, 'child').handles).toEqual(['job']);
  expect(nodeById(await cleanupSubagent(tree, 'child', workspacePort), 'child').status).toBe('cancelled');
});
