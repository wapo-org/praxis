import {expect, it} from 'vitest';
import {z} from 'zod';
import {
  CloseAgentResultSchema, SendAgentMessageResultSchema, SubagentAddressResultSchema,
  SubagentToolResultSchema, WaitAgentsSchema,
} from '@praxis/protocol';
import {harnessFixture} from './tools-fixture.js';
import {reduceSubagents} from './reducer.js';
import {createRequest} from './test-fixtures.js';
import {answerWith, fixture, response} from '../one-turn-fixture.js';
import {runOneTurn} from '../one-turn.js';
import {ToolResultSchema} from '../types.js';

it('publishes uniqueness constraints for wait addresses and child grants', () => {
  const tools = harnessFixture().harness.tools;
  const wait = tools.find(tool => tool.spec.name === 'wait_agents')!;
  expect(wait.spec.inputSchema).toMatchObject({properties: {subagent_ids: {uniqueItems: true}}});
  expect(z.toJSONSchema(WaitAgentsSchema, {io: 'input'})).toMatchObject({properties: {subagent_ids: {uniqueItems: true}}});
  const spawn = tools.find(tool => tool.spec.name === 'spawn_agent')!;
  expect(spawn.spec.inputSchema).toMatchObject({oneOf: expect.arrayContaining([
    expect.objectContaining({properties: expect.objectContaining({tools: expect.objectContaining({uniqueItems: true})})}),
  ])});
});

it.each([false, true])('settles invalid arguments and replays the schema ToolError after rehydration (legacy catalog: %s)', async legacy => {
  for (const [name, args] of [
    ['wait_agents', {subagent_ids: ['child', 'child'], mode: 'all', timeout_ms: 0}],
    ['spawn_agent', {...createRequest, tools: ['read_file', 'read_file']}],
  ] as const) {
    const f = harnessFixture();
    const opts = await fixture();
    let executions = 0;
    let transactions = 0;
    f.port.transact = async () => {transactions++; throw new Error('Invalid input must never reach persistence');};
    opts.tools = f.harness.tools.map(tool => ({...tool, async execute(args, context) {
      executions++;
      return tool.execute(args, context);
    }}));
    opts.registry = f.harness.registry;
    // Frozen catalogs can predate uniqueness metadata, so the runtime boundary must settle invalid arguments too.
    opts.store.data.snapshot.request.tools = opts.tools.map(tool => legacy ? {...tool.spec, inputSchema: {type: 'object'}} : tool.spec);
    answerWith(opts.provider, async () => ({...response(true), parts: [
      {type: 'toolCall', callId: 'invalid', name, arguments: JSON.stringify(args)},
    ]}));
    opts.store.commit = async () => {throw new Error('Crash after saveCall');};
    await expect(runOneTurn(opts)).rejects.toThrow('Crash after saveCall');
    const saved = opts.store.data.calls.invalid;
    expect(saved).not.toBeNull();
    if (!saved) throw new Error('Expected a settled tool result');
    const result = saved.result.ok ? ToolResultSchema.parse(saved.result.result.value) : saved.result;
    expect(result).toMatchObject({error: {code: 'schema', remediation: expect.any(String)}});
    expect(result.error?.remediation.length).toBeGreaterThan(0);
    opts.store = opts.store.rehydrateAfterFencing();
    await expect(runOneTurn(opts)).resolves.toMatchObject({status: 'ready', turnIndex: 1});
    expect(executions).toBe(legacy ? 1 : 0);
    expect(transactions).toBe(0);
    expect(opts.store.data.calls.invalid).toEqual(saved);
  }
});

it('validates shared address, message and close acknowledgements before returning them', async () => {
  const f = harnessFixture();
  const created = await f.call('spawn_agent', createRequest);
  const address = SubagentAddressResultSchema.parse(JSON.parse(String(created.content[0]?.text)));
  expect(address).toEqual({subagent_id: 'child-1'});
  const sent = await f.call('message_agent', {action: 'send', subagent_id: address.subagent_id, message: 'update'});
  expect(SendAgentMessageResultSchema.parse(JSON.parse(String(sent.content[0]?.text))))
    .toMatchObject({subagent_id: address.subagent_id, message_id: 'message-2'});
  f.tree = reduceSubagents(f.tree, {type: 'start', id: address.subagent_id});
  f.tree = reduceSubagents(f.tree, {type: 'pause', id: address.subagent_id});
  const configured = await f.call('message_agent', {action: 'configure', subagent_id: address.subagent_id, name: 'renamed'});
  expect(SubagentAddressResultSchema.parse(JSON.parse(String(configured.content[0]?.text)))).toEqual(address);
  const resumed = await f.call('spawn_agent', {action: 'resume', subagent_id: address.subagent_id});
  expect(SubagentAddressResultSchema.parse(JSON.parse(String(resumed.content[0]?.text)))).toEqual(address);
  const closed = await f.call('close_agent', {subagent_id: address.subagent_id});
  expect(CloseAgentResultSchema.parse(JSON.parse(String(closed.content[0]?.text))))
    .toEqual({subagent_id: address.subagent_id, status: 'cancelling'});
  for (const value of [{subagent_id: '../escape'}, {subagent_id: 'child', message_id: ''},
    {subagent_id: 'child', status: 'unknown'}, {subagent_id: 'child', secret: 'unexpected'}]) {
    expect(SubagentToolResultSchema.safeParse(value).success).toBe(false);
  }
});

it('rejects malformed and wrong-operation acknowledgements after the transaction boundary', async () => {
  const f = harnessFixture();
  for (const result of [{subagent_id: '../escape'}, {subagent_id: 'child', status: 'running' as const}]) {
    f.port.transact = async () => ({tree: f.tree, result, tainted: false});
    await expect(f.call('spawn_agent', createRequest)).rejects.toBeInstanceOf(z.ZodError);
  }
});
