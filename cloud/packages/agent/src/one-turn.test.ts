import {expect, it} from 'vitest';
import fc from 'fast-check';
import {runOneTurn, UncertainToolCall} from './one-turn.js';
import {fixture, response} from './one-turn-fixture.js';
import {argsHash, issueApproval} from './boundary/receipt.js';
import {textResult} from './types.js';

it('TurnCommitOnce: duplicate and concurrent expectedTurnIndex deliveries do no extra work', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 1, max: 10}), async duplicates => {
    const f = await fixture();
    await Promise.all(Array.from({length: duplicates}, () => runOneTurn(f)));
    for (let i = 0; i < duplicates; i++) await runOneTurn(f);
    expect(f.counts.model).toBe(1);
    expect(f.store.data.commits).toBe(1);
    expect(f.store.data.usage).toBe(10);
    expect(f.store.data.flags.turnIndex).toBe(1);
  }), {numRuns: 50, seed: 78});
});

it('CheckpointReplayStable: a JSON round-trip reuses the response and completed result after a lost save reply', async () => {
  const f = await fixture(true);
  const save = f.store.saveCall.bind(f.store);
  f.store.saveCall = async (...args) => {
    await save(...args);
    throw new Error('lost acknowledgement');
  };
  await expect(runOneTurn(f)).rejects.toThrow('lost acknowledgement');
  f.store = f.store.rehydrateAfterFencing();
  await runOneTurn(f);
  expect(f.counts).toEqual({model: 1, tool: 1});
  expect(f.store.data.tainted).toBe(true);
  expect(f.store.data.commits).toBe(1);
});

it('a lost final commit reply replays flags without the model or tools', async () => {
  const f = await fixture();
  const commit = f.store.commit.bind(f.store);
  f.store.commit = async (...args) => {
    await commit(...args);
    throw new Error('lost commit reply');
  };
  await expect(runOneTurn(f)).rejects.toThrow();
  expect(await runOneTurn(f)).toEqual({done: true, status: 'completed', turnIndex: 1});
  expect(f.counts.model).toBe(1);
});

it('CancelFence: stop during the model fences response persistence and tool execution', async () => {
  const f = await fixture(true);
  f.provider.complete = async () => {
    f.store.stop();
    return response(true);
  };
  expect((await runOneTurn(f)).status).toBe('stopped');
  expect(f.store.data.response).toBeUndefined();
  expect(f.counts.tool).toBe(0);
  expect(f.store.data.commits).toBe(0);
});

it('CancelFence: stop after one tool prevents the next tool and the final commit', async () => {
  const f = await fixture(true);
  const r = response(true);
  r.parts.push({...r.parts[0]!, callId: 'second'});
  f.provider.complete = async () => r;
  f.tools = [{...f.tools[0]!, async execute() {
    f.counts.tool++;
    f.store.stop();
    return textResult('partial');
  }}];
  expect((await runOneTurn(f)).status).toBe('stopped');
  expect(f.counts.tool).toBe(1);
  expect(f.store.data.commits).toBe(0);
});

it('an ambiguous started call cannot be blindly replayed after process loss', async () => {
  const f = await fixture(true);
  f.store.data.response = response(true);
  f.store.data.calls.call = null;
  await expect(runOneTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
  expect(f.counts).toEqual({model: 0, tool: 0});
});

it('PRA-76: structural taint requires an exactly bound receipt before an effect', async () => {
  for (const approved of [false, true]) {
    const f = await fixture(true);
    f.store.data.snapshot.tainted = true;
    f.registry = {classify: () => ({capabilities: ['write'], decision: 'allow', untrustedSource: false})};
    if (approved) f.receipts = {call: await issueApproval(f.boundary.key,
      {runId: 'run', toolCallId: 'call', tool: 'read', argsHash: await argsHash({query: 'hello'})}, 100, 'nonce')};
    await runOneTurn(f);
    expect(f.counts.tool).toBe(approved ? 1 : 0);
    const saved = f.store.data.calls.call!;
    expect(saved.result.ok).toBe(approved);
    if (!saved.result.ok) expect(saved.result.error).toMatchObject({code: 'taint-blocked', remediation: expect.any(String)});
    expect(f.store.data.tainted).toBe(true);
  }
});

it('invalid arguments and unknown tools return actionable schema errors without dispatch', async () => {
  for (const part of [{name: 'read', arguments: '{'}, {name: 'unknown', arguments: '{}'}, {name: 'read', arguments: '{"query":1}'}]) {
    const f = await fixture(true);
    f.provider.complete = async () => ({...response(true), parts: [{type: 'toolCall', callId: 'call', ...part}]});
    await runOneTurn(f);
    expect(f.counts.tool).toBe(0);
    expect(f.store.data.calls.call?.result).toMatchObject({ok: false, error: {code: part.name === 'unknown' ? 'policy-denied' : 'schema'}});
  }
});

it('duplicate call identities are rejected before dispatch', async () => {
  const f = await fixture(true);
  const r = response(true);
  r.parts.push(r.parts[0]!);
  f.provider.complete = async () => r;
  await expect(runOneTurn(f)).rejects.toThrow('duplicate');
  expect(f.counts.tool).toBe(0);
});

it('a future turn and an incomplete stream cannot advance the durable turn', async () => {
  const f = await fixture();
  expect((await runOneTurn({...f, expectedTurnIndex: 1})).turnIndex).toBe(0);
  f.provider.stream = async function* () {
    yield {type: 'text', index: 0, text: 'partial'};
  };
  await expect(runOneTurn(f)).rejects.toThrow('without a completed response');
  expect(f.store.data.commits).toBe(0);
});

it('uses the landed mode decision table for confined writes and external egress', async () => {
  for (const mode of ['ask', 'plan', 'build', 'auto'] as const) {
    for (const external of [false, true]) {
      const f = await fixture(true);
      f.store.data.snapshot.mode = mode;
      f.registry = {classify: () => ({capabilities: external ? ['external-egress'] : ['write'], decision: 'allow', untrustedSource: false})};
      await runOneTurn(f);
      expect(f.counts.tool).toBe(!external && (mode === 'build' || mode === 'auto') ? 1 : 0);
    }
  }
});

it('replayed failed reads persist taint before the next call and final commit', async () => {
  const f = await fixture(true);
  const r = response(true);
  r.parts.push({...r.parts[0]!, callId: 'second'});
  f.store.data.response = r;
  f.store.data.calls.call = {call: {tool: 'read', args: {query: 'hello'}}, result: {
    ok: false, untrustedSource: true, taint: {tainted: true},
    error: {code: 'not-found', message: 'workspace instruction', remediation: 'Choose a symbol.'},
  }};
  f.registry = {classify: () => ({capabilities: ['write'], decision: 'allow', untrustedSource: false})};
  await runOneTurn(f);
  expect(f.counts.tool).toBe(0);
  expect(f.store.data.calls.second?.result).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
  expect(f.store.data.tainted).toBe(true);
});
