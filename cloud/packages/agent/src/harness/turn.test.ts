import {describe, expect, it} from 'vitest';
import {argsHash, issueApproval} from '../boundary/receipt.js';
import {ToolBoundaryError, toolError} from '../boundary/errors.js';
import {textResult} from '../types.js';
import {readCall, readTool, SCENARIO_NOW_MS, turnFixture} from './turn-fixture.js';
import {runTurn, toolBoundaryClassifier, UncertainToolCall} from './turn.js';
import {fakeRegistry, fakeTools} from './fake-model.js';

const twoReads = () => ({calls: [{id: 'call', name: 'read', args: {query: 'hello'}}, {id: 'second', name: 'read', args: {query: 'hello'}}]});

describe('one turn on the AI SDK', () => {
  it('a text reply commits once with usage and ends the run', async () => {
    const f = await turnFixture([{text: 'done'}]);
    const run = await runTurn(f);
    expect(run).toMatchObject({state: 'output', output: {end: {status: 'completed'}, usage: {cost: 0.0001}}});
    expect(f.counts).toEqual({model: 1, tool: 0});
    expect(f.ledger.responseSaves).toBe(1);
  });

  it('CheckpointReplayStable: a JSON round trip reuses the response and the completed result after a lost save reply', async () => {
    const f = await turnFixture();
    const save = f.ledger.saveCall.bind(f.ledger);
    f.ledger.saveCall = async (...args) => {
      await save(...args);
      throw new Error('lost acknowledgement');
    };
    await expect(runTurn(f)).rejects.toThrow('lost acknowledgement');
    f.ledger = f.ledger.rehydrated();
    const run = await runTurn(f);
    expect(f.counts).toEqual({model: 1, tool: 1});
    expect(run).toMatchObject({state: 'output', output: {tainted: true, end: {status: 'ready'}}});
  });

  it('a retried attempt after a lost commit reply replays the saved response and results without the model or tools', async () => {
    const f = await turnFixture();
    const first = await runTurn(f);
    f.ledger = f.ledger.rehydrated();
    const second = await runTurn({...f, newId: (() => {
      let ids = 0;
      return () => `msg-${ids++}`;
    })()});
    expect(f.counts).toEqual({model: 1, tool: 1});
    expect(second).toEqual({...first, output: {...(first as {output: object}).output, messages: expect.any(Array)}});
  });

  it('CancelFence: stop during the model call fences response persistence and tool execution', async () => {
    const f = await turnFixture(() => {
      f.ledger.stopped = true;
      return readCall();
    });
    expect(await runTurn(f)).toEqual({state: 'inactive'});
    expect(f.ledger.saved).toBeUndefined();
    expect(f.counts.tool).toBe(0);
  });

  it('CancelFence: stop after one tool prevents the next tool and the output', async () => {
    const f = await turnFixture([twoReads()]);
    f.tools = [{...f.tools[0]!, async execute() {
      f.counts.tool++;
      f.ledger.stopped = true;
      return textResult('partial');
    }}];
    expect(await runTurn(f)).toEqual({state: 'inactive'});
    expect(f.counts.tool).toBe(1);
  });

  it('an ambiguous started call cannot be blindly replayed after process loss', async () => {
    const f = await turnFixture();
    await expect(runTurn({...f, tools: [{...readTool, async execute() {
      throw new Error('process lost mid-call');
    }}]})).rejects.toBeInstanceOf(UncertainToolCall);
    f.ledger = f.ledger.rehydrated();
    await expect(runTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
    expect(f.counts).toEqual({model: 1, tool: 0});
  });

  it('an accepted effect with a lost reply stays uncertain and fences the rest of the batch and retries', async () => {
    for (const typed of [false, true]) {
      const f = await turnFixture([twoReads()]);
      let effects = 0;
      f.tools = [{...readTool, async execute() {
        effects++;
        if (typed) throw new ToolBoundaryError(toolError('upstream', 'Lost reply.'));
        throw new Error('Lost reply.');
      }}];
      await expect(runTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
      expect(f.ledger.calls.call).toBeNull();
      expect(f.ledger.calls.second).toBeUndefined();
      f.ledger = f.ledger.rehydrated();
      await expect(runTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
      expect(effects).toBe(1);
    }
  });

  it('PRA-76: structural taint requires an exactly bound receipt before an effect', async () => {
    for (const approved of [false, true]) {
      const f = await turnFixture();
      f.input = {...f.input, tainted: true};
      f.registry = {classify: () => ({capabilities: ['write'], decision: 'allow', untrustedSource: false})};
      if (approved) f.receipts = {call: await issueApproval(f.boundary.key,
        {runId: 'run', toolCallId: 'call', tool: 'read', argsHash: await argsHash({query: 'hello'})}, SCENARIO_NOW_MS + 100, 'nonce')};
      await runTurn(f);
      expect(f.counts.tool).toBe(approved ? 1 : 0);
      const saved = f.ledger.calls.call!;
      expect(saved.result.ok).toBe(approved);
      if (!saved.result.ok) expect(saved.result.error).toMatchObject({code: 'taint-blocked', remediation: expect.any(String)});
    }
  });

  it('invalid arguments and unknown tools return actionable errors without dispatch', async () => {
    for (const [name, args] of [['read', '{'], ['unknown', '{}'], ['read', '{"query":1}']] as const) {
      const f = await turnFixture([{calls: [{id: 'call', name, args}]}]);
      const run = await runTurn(f);
      expect(run.state).toBe('output');
      expect(f.counts.tool).toBe(0);
      expect(f.ledger.calls.call?.result).toMatchObject({ok: false, error: {code: name === 'unknown' ? 'policy-denied' : 'schema'}});
    }
  });

  it('duplicate call identities are rejected before dispatch', async () => {
    const f = await turnFixture([{calls: [{id: 'call', name: 'read', args: {query: 'a'}}, {id: 'call', name: 'read', args: {query: 'b'}}]}]);
    await expect(runTurn(f)).rejects.toThrow('duplicate');
    expect(f.counts.tool).toBe(0);
  });

  it('uses the landed mode decision table for confined writes and external egress', async () => {
    for (const mode of ['ask', 'plan', 'build', 'auto'] as const) {
      for (const external of [false, true]) {
        const f = await turnFixture();
        f.input = {...f.input, mode};
        f.registry = {classify: () => ({capabilities: external ? ['external-egress'] : ['write'], decision: 'allow', untrustedSource: false})};
        await runTurn(f);
        expect(f.counts.tool).toBe(!external && (mode === 'build' || mode === 'auto') ? 1 : 0);
      }
    }
  });

  it('replayed failed reads keep taint before the next call', async () => {
    const f = await turnFixture([twoReads()]);
    f.ledger.calls.call = {call: {tool: 'read', args: {query: 'hello'}}, result: {
      ok: false, untrustedSource: true, taint: {tainted: true},
      error: {code: 'not-found', message: 'workspace instruction', remediation: 'Choose a symbol.'},
    }};
    f.registry = {classify: () => ({capabilities: ['write'], decision: 'allow', untrustedSource: false})};
    const run = await runTurn(f);
    expect(f.counts.tool).toBe(0);
    expect(f.ledger.calls.second?.result).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
    expect(run).toMatchObject({state: 'output', output: {tainted: true}});
  });

  it('model dispatch cannot use hidden, unavailable, disabled or unoffered tools', async () => {
    for (const restriction of ['hidden', 'unavailable', 'disabled', 'unoffered']) {
      const f = await turnFixture();
      if (restriction === 'hidden') f.tools = [{...f.tools[0]!, hidden: true}];
      if (restriction === 'unavailable') f.tools = [{...f.tools[0]!, unavailableReason: 'Disconnected'}];
      if (restriction === 'disabled') f.input = {...f.input, toolsEnabled: false};
      if (restriction === 'unoffered') f.input = {...f.input, tools: []};
      await runTurn(f);
      expect(f.counts.tool).toBe(0);
      expect(f.ledger.calls.call?.result).toMatchObject({ok: false, error: {code: 'policy-denied'}});
    }
  });

  it('the frozen schema constrains dispatch even when the live adapter schema becomes broader', async () => {
    const f = await turnFixture([{calls: [{id: 'call', name: 'read', args: {query: 42}}]}]);
    f.tools = [{...f.tools[0]!, spec: {...readTool.spec, inputSchema: {type: 'object'}}}];
    await runTurn(f);
    expect(f.counts.tool).toBe(0);
    expect(f.ledger.calls.call?.result).toMatchObject({ok: false, error: {code: 'schema'}});
  });

  it('a 401 or 402 ends the turn as failed and keeps nothing; other provider failures throw for the workflow retry', async () => {
    for (const [status, code] of [[401, 'model_key_invalid'], [402, 'model_credit_exhausted']] as const) {
      const f = await turnFixture([{error: {status, message: 'No.'}}]);
      expect(await runTurn(f)).toMatchObject({state: 'failed', failure: {code}});
      expect(f.ledger.saved).toBeUndefined();
    }
    const rateLimited = await turnFixture([{error: {status: 429, message: 'Slow down'}}]);
    await expect(runTurn(rateLimited)).rejects.toMatchObject({kind: 'rateLimited', retryable: true});
    const bad = await turnFixture([{error: {status: 400, message: 'Bad request'}}]);
    await expect(runTurn(bad)).rejects.toMatchObject({kind: 'fatal', status: 400});
  });

  it('a tool’s own boundary classification wins over the registry, which still covers the rest', () => {
    const web = {...readTool, spec: {...readTool.spec, name: 'web_search'},
      boundary: {capabilities: ['read', 'external-egress'], decision: 'allow', untrustedSource: true} as const};
    const registry = toolBoundaryClassifier([web, ...fakeTools()], fakeRegistry);
    expect(registry.classify({tool: 'web_search', args: {}})).toEqual(web.boundary);
    expect(registry.classify({tool: 'write', args: {}})).toMatchObject({decision: 'approve'});
    expect(registry.classify({tool: 'unknown', args: {}})).toBeUndefined();
  });
});
