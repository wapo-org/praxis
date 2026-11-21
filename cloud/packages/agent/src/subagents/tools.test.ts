import {expect, it} from 'vitest';
import {SUBAGENT_TOOL_NAMES} from '@praxis/protocol';
import {harnessFixture} from './tools-fixture.js';
import {createRequest, handoff, workspacePort} from './test-fixtures.js';
import {reduceSubagents} from './reducer.js';
import {VerifiedHandoff} from './handoff.js';
import {defaultChildTools} from './tools.js';
import {turnFixture} from '../harness/turn-fixture.js';
import {runTurn} from '../harness/turn.js';
import {ToolBoundaryError, toolError} from '../boundary/errors.js';
import {executeBoundary} from '../boundary/gate.js';

const request = {...createRequest, tools: [...SUBAGENT_TOOL_NAMES, 'read_file']};
it('registers exactly the shared surface and narrows trusted default grants', () => {
  const f = harnessFixture();
  expect(f.harness.tools.map(tool => tool.spec.name)).toEqual(SUBAGENT_TOOL_NAMES);
  expect(defaultChildTools(f.tree.nodes[0]!.permissions.tools, f.metadata)).toEqual([...SUBAGENT_TOOL_NAMES, 'read_file', 'edit_file']);
  expect(defaultChildTools(['edit_file'], [{...f.metadata[5]!, name: 'edit_file', confinedToChildWorkspace: false,
    classification: {capabilities: ['exec'], decision: 'allow', untrustedSource: false}}])).toEqual([]);
});

it('scripts spawn → discover → send → wait, peer/parent messaging and hidden ID denial', async () => {
  const f = harnessFixture();
  expect((await f.call('spawn_agent', request)).isError).toBe(false);
  expect((await f.call('spawn_agent', request)).isError).toBe(false);
  expect(JSON.stringify(await f.call('message_agent', {action: 'discover'}))).toContain('child-1');
  f.tree = reduceSubagents(f.tree, {type: 'start', id: 'child-1'});
  f.tree = reduceSubagents(f.tree, {type: 'start', id: 'child-2'});
  f.actor('child-1');
  expect((await f.call('message_agent', {action: 'send', subagent_id: 'root', message: 'parent update'})).isError).toBe(false);
  expect((await f.call('message_agent', {action: 'send', subagent_id: 'child-2', message: 'peer update'})).isError).toBe(false);
  expect((await f.call('close_agent', {subagent_id: 'child-2'})).isError).toBe(true);
  expect((await f.call('message_agent', {action: 'configure', subagent_id: 'child-2', name: 'forged'})).isError).toBe(true);
  f.tree.nodes[1]!.permissions.discover_siblings = false;
  const found = await f.call('message_agent', {action: 'discover'});
  expect(JSON.stringify(found)).not.toContain('child-2');
  expect((await f.call('message_agent', {action: 'send', subagent_id: 'child-2', message: 'hidden'})).isError).toBe(true);
  expect((await f.call('wait_agents', {subagent_ids: ['child-2'], mode: 'any', timeout_ms: 0})).isError).toBe(true);
  f.actor('root');
  const waiting = await f.call('wait_agents', {subagent_ids: ['child-1', 'child-2'], mode: 'all', timeout_ms: 0});
  expect(JSON.stringify(waiting)).toContain('timeout');
  expect(f.tree.nodes[1]!.status).toBe('running');
});

it('configures only safe waiting children; model/effort resume preserves turns, grants and taint', async () => {
  const f = harnessFixture();
  f.context.tainted = true;
  await f.call('spawn_agent', request);
  expect(f.tree.nodes[1]!.tainted).toBe(true);
  f.tree = reduceSubagents(f.tree, {type: 'start', id: 'child-1'});
  f.tree = reduceSubagents(f.tree, {type: 'turn', id: 'child-1'});
  expect((await f.call('message_agent', {action: 'configure', subagent_id: 'child-1', name: 'new'})).isError).toBe(true);
  f.tree = reduceSubagents(f.tree, {type: 'pause', id: 'child-1'});
  expect((await f.call('message_agent', {action: 'configure', subagent_id: 'child-1', name: 'new', model: 'small', effort: 'low'})).isError).toBe(false);
  expect((await f.call('spawn_agent', {action: 'resume', subagent_id: 'child-1'})).isError).toBe(false);
  expect(f.tree.nodes[1]).toMatchObject({name: 'new', model: 'small', effort: 'low', revision: 1, turns: 1, tainted: true,
    permissions: {tools: request.tools}});
});

it('rejects widening, unsafe defaults, unsupported models and inherited incompatible effort without mutation', async () => {
  const f = harnessFixture();
  for (const args of [
    {...request, tools: ['unknown']}, {...request, tools: ['outbound']}, {...request, tools: ['secret']},
    {...request, tools: ['destroy']}, {...request, model: 'removed'}, {...request, model: 'small'},
    {...request, model: 'text'}, {...request, model: 'small', effort: 'high'},
  ]) {
    const before = structuredClone(f.tree);
    expect((await f.call('spawn_agent', args)).isError).toBe(true);
    expect(f.tree).toEqual(before);
  }
  f.metadata.find(tool => tool.name === 'outbound')!.explicitGrant = true;
  expect((await f.call('spawn_agent', {...request, tools: ['outbound']})).isError).toBe(false);
});

it('returns verified completions and failed/cancelled results, resumes failures and rejects cancelled resume', async () => {
  const f = harnessFixture();
  await f.call('spawn_agent', request);
  await f.call('spawn_agent', request);
  const proof = await VerifiedHandoff.verify(handoff('child-1'), {id: 'child-1', revision: 0, requiredChecks: ['typecheck']}, workspacePort);
  f.tree = reduceSubagents(f.tree, {type: 'complete', id: 'child-1', proof: proof!});
  f.tree = reduceSubagents(f.tree, {type: 'fail', id: 'child-2', message: 'failed'});
  const ready = await f.call('wait_agents', {subagent_ids: ['child-1', 'child-2'], mode: 'all', timeout_ms: 100});
  expect(JSON.stringify(ready)).toContain('completed');
  expect(JSON.stringify(ready)).toContain('failed');
  expect((await f.call('spawn_agent', {action: 'resume', subagent_id: 'child-2'})).isError).toBe(false);
  await f.call('close_agent', {subagent_id: 'child-2'});
  f.tree = reduceSubagents(f.tree, {type: 'finalize', id: 'child-2'});
  expect((await f.call('spawn_agent', {action: 'resume', subagent_id: 'child-2'})).isError).toBe(true);
});

it('joins peer taint before the next harness effect, requiring a fresh receipt', async () => {
  const f = harnessFixture();
  await f.call('spawn_agent', request);
  f.tree = reduceSubagents(f.tree, {type: 'taint', id: 'child-1'});
  f.actor('child-1');
  await f.call('message_agent', {action: 'send', subagent_id: 'root', message: 'untrusted coordination'});
  f.actor('root');
  const opts = await turnFixture([{calls: [
    {id: 'discover', name: 'message_agent', args: {action: 'discover'}},
    {id: 'effect', name: 'read', args: {query: 'effect'}},
  ]}]);
  opts.tools = [...f.harness.tools, ...opts.tools];
  opts.registry = {classify: call => f.harness.registry.classify(call) ??
    {capabilities: ['write'], decision: 'allow', untrustedSource: false}};
  opts.input = {...opts.input, tools: opts.tools.map(tool => tool.spec)};
  const run = await runTurn(opts);
  expect(opts.counts.tool).toBe(0);
  expect(run).toMatchObject({state: 'output', output: {tainted: true}});
  expect(opts.ledger.calls.effect?.result).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
  const result = await executeBoundary({tool: 'outbound', args: {}}, {...opts.boundary, runId: 'run', toolCallId: 'outbound',
    taint: {tainted: false}, mode: 'auto'}, {classify: () => f.metadata.find(tool => tool.name === 'outbound')!.classification}, async () => null);
  expect(result).toMatchObject({ok: false, error: {code: 'approval-required'}});
});

it('retains committed taint when the durable wait returns an actionable error', async () => {
  const f = harnessFixture();
  await f.call('spawn_agent', request);
  f.context.tainted = true;
  f.port.wait = async () => {throw new ToolBoundaryError(toolError('conflict', 'Reload the durable wait.'));};
  expect(await f.call('wait_agents', {subagent_ids: ['child-1'], mode: 'all', timeout_ms: 1}))
    .toMatchObject({isError: true, tainted: true, error: {code: 'conflict'}});
});

it('self-close cascades and remains idempotent while cancelling', async () => {
  const f = harnessFixture();
  await f.call('spawn_agent', request);
  expect((await f.call('close_agent', {subagent_id: 'root'})).isError).toBe(false);
  expect((await f.call('close_agent', {subagent_id: 'root'})).isError).toBe(false);
  expect(f.tree.nodes.every(node => node.status === 'cancelling')).toBe(true);
});
