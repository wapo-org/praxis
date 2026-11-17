import {expect, it} from 'vitest';
import {answerWith, fixture, response, testTool} from './one-turn-fixture.js';
import {runOneTurn, UncertainToolCall} from './one-turn.js';
import {ToolBoundaryError, toolError} from './boundary/errors.js';

it('an accepted effect with a lost reply stays uncertain and fences the rest of the batch and retries', async () => {
  for (const typed of [false, true]) {
    const f = await fixture(true);
    const r = response(true);
    r.parts.push({...r.parts[0]!, callId: 'second'});
    answerWith(f.provider, async () => r);
    let effects = 0;
    f.tools = [{...testTool, async execute() {
      effects++;
      if (typed) throw new ToolBoundaryError(toolError('upstream', 'Lost reply.'));
      throw new Error('Lost reply.');
    }}];
    await expect(runOneTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
    expect(f.store.data.calls.call).toBeNull();
    expect(f.store.data.calls.second).toBeUndefined();
    expect(f.store.data.commits).toBe(0);
    f.store = f.store.rehydrateAfterFencing();
    await expect(runOneTurn(f)).rejects.toBeInstanceOf(UncertainToolCall);
    expect(effects).toBe(1);
  }
});

it('model dispatch cannot use hidden, unavailable, disabled or unoffered tools', async () => {
  for (const restriction of ['hidden', 'unavailable', 'disabled', 'unoffered']) {
    const f = await fixture(true);
    if (restriction === 'hidden') f.tools = [{...f.tools[0]!, hidden: true}];
    if (restriction === 'unavailable') f.tools = [{...f.tools[0]!, unavailableReason: 'Disconnected'}];
    if (restriction === 'disabled') f.store.data.snapshot.request.capabilities.tools = false;
    if (restriction === 'unoffered') f.store.data.snapshot.request.tools = [];
    await runOneTurn(f);
    expect(f.counts.tool).toBe(0);
    expect(f.store.data.calls.call?.result).toMatchObject({ok: false, error: {code: 'policy-denied'}});
  }
});

it('the frozen schema constrains dispatch even when the live adapter schema becomes broader', async () => {
  const f = await fixture(true);
  f.tools = [{...f.tools[0]!, spec: {...testTool.spec, inputSchema: {type: 'object'}}}];
  answerWith(f.provider, async () => ({...response(true), parts: [{type: 'toolCall', callId: 'call', name: 'read', arguments: '{"query":42}'}]}));
  await runOneTurn(f);
  expect(f.counts.tool).toBe(0);
  expect(f.store.data.calls.call?.result).toMatchObject({ok: false, error: {code: 'schema'}});
});
