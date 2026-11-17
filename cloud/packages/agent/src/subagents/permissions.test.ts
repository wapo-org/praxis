import {it, expect} from 'vitest';
import fc from 'fast-check';
import {SUBAGENT_TOOL_NAMES, SubagentToolCallSchema, type SpawnAgent} from '@praxis/protocol';
import {canSee, discoverAgents, narrowTools, nodeById, workspaceFor} from './permissions.js';
import {reduceSubagents} from './reducer.js';
import {treeFixture, spawn, createRequest} from './test-fixtures.js';

it('provides exactly four strict tools and folds resume/configure/discovery into them', () => {
  expect(SUBAGENT_TOOL_NAMES).toEqual(['spawn_agent', 'message_agent', 'wait_agents', 'close_agent']);
  for (const call of [
    {tool: 'spawn_agent', args: createRequest},
    {tool: 'spawn_agent', args: {action: 'resume', subagent_id: 'child'}},
    {tool: 'message_agent', args: {action: 'discover'}},
    {tool: 'message_agent', args: {action: 'configure', subagent_id: 'child', name: 'new'}},
    {tool: 'message_agent', args: {action: 'send', subagent_id: 'child', message: 'hello'}},
    {tool: 'wait_agents', args: {subagent_ids: ['child'], mode: 'all', timeout_ms: 0}},
    {tool: 'close_agent', args: {subagent_id: 'child'}},
  ]) expect(SubagentToolCallSchema.safeParse(call).success).toBe(true);
  expect(SubagentToolCallSchema.safeParse({tool: 'rename_agent', args: {}}).success).toBe(false);
  expect(SubagentToolCallSchema.safeParse({tool: 'close_agent', args: {subagent_id: 'child', userId: 'other'}}).success).toBe(false);
});
it.each(['../escape', '/absolute', 'a/b', '..', 'a%2fb'])('rejects unsafe workspace ids: %s', id => {
  expect(() => workspaceFor(id)).toThrow();
});
it('narrows tool sets without escalation for arbitrary subsets', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.string({minLength: 1})), fc.boolean(), (parent, all) => {
    const requested = all ? parent : parent.slice(0, Math.floor(parent.length / 2));
    expect(narrowTools(parent, requested).every(t => parent.includes(t))).toBe(true);
    expect(() => narrowTools(parent, [...requested, '__forbidden__' + parent.join('')])).toThrow();
  }), {numRuns: 500});
});
it.each([
  {turn_cap: 4}, {visibility_depth: 5}, {tools: ['network_send']},
])('refuses permission escalation: %j', extra => {
  const request: Extract<SpawnAgent, {action: 'create'}> = {...createRequest, ...extra};
  expect(() => reduceSubagents(treeFixture(), {type: 'spawn', actorId: 'root', id: 'child', callId: 'c', request})).toThrow();
});
it('enforces depth and sibling discovery independently', () => {
  let tree = treeFixture();
  nodeById(tree, 'root').permissions.max_depth = 1;
  tree = spawn(spawn(tree), 'sibling');
  expect(() => spawn(tree, 'grandchild', 'child')).toThrow('depth');
  const child = nodeById(tree, 'child'), sibling = nodeById(tree, 'sibling');
  for (const depth of [0, 1, 2, 3]) for (const siblings of [false, true]) {
    child.permissions.visibility_depth = depth;
    child.permissions.discover_siblings = siblings;
    expect(canSee(tree, child, sibling)).toBe(siblings && depth >= 2);
    expect(canSee(tree, child, nodeById(tree, 'root'))).toBe(true);
  }
  expect(Object.keys(discoverAgents(tree, 'child').result.agents[0]!)).toEqual(['id', 'parent_id', 'name', 'status', 'tainted']);
});
it('inherits taint on spawn and propagates later parent taint downward', () => {
  let tree = reduceSubagents(treeFixture(), {type: 'taint', id: 'root'});
  tree = spawn(tree);
  expect(nodeById(tree, 'child').tainted).toBe(true);
  const clean = spawn(spawn(treeFixture()), 'grandchild', 'child');
  expect(reduceSubagents(clean, {type: 'taint', id: 'root'}).nodes.every(n => n.tainted)).toBe(true);
});
it('discovery does not grant sibling lifecycle control or hidden messaging', () => {
  let tree = spawn(spawn(treeFixture()), 'sibling');
  tree = reduceSubagents(tree, {type: 'start', id: 'sibling'});
  tree = reduceSubagents(tree, {type: 'pause', id: 'sibling'});
  expect(() => reduceSubagents(tree, {type: 'configure', actorId: 'child', id: 'sibling', name: 'hijack'})).toThrow('parent');
  expect(() => reduceSubagents(tree, {type: 'stop', actorId: 'child', id: 'sibling'})).toThrow('parent');
  nodeById(tree, 'child').permissions.discover_siblings = false;
  expect(() => reduceSubagents(tree, {type: 'send', actorId: 'child', id: 'sibling', messageId: 'm', text: 'x'})).toThrow('visibility');
});
it('tainted peer messages carry structural provenance into the recipient subtree', () => {
  let tree = spawn(spawn(treeFixture()), 'sibling');
  tree = reduceSubagents(tree, {type: 'taint', id: 'child'});
  tree = reduceSubagents(tree, {type: 'send', actorId: 'child', id: 'sibling', messageId: 'm', text: 'external data'});
  expect(nodeById(tree, 'sibling')).toMatchObject({tainted: true, inbox: [{tainted: true}]});
});
it('rejects forged spawn events after the tool grant was narrowed away', () => {
  const tree = treeFixture();
  const child = reduceSubagents(tree, {type: 'spawn', actorId: 'root', id: 'child', callId: 'child',
    request: {...createRequest, tools: ['read_file']}});
  expect(() => spawn(child, 'grandchild', 'child')).toThrow('Spawn permission');
});
