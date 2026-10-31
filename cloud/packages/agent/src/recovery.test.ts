import {describe, expect, it} from 'vitest';
import {RunEventPayloadSchema, type RunEventPayload} from '@praxis/protocol';
import {AgentRunner, createScriptedProvider, scriptedTools, textResult, type AgentCheckpoint, type AgentPorts, type AgentTool, type RunInput} from './index.js';

const time = '2026-10-29T12:00:00.000Z';
const input = (): RunInput => ({
  userId: 'u',
  run: {type: 'run', id: 'r', chatId: 'c', status: 'queued', createdAt: time, updatedAt: time, lastEventId: 0},
  chat: {type: 'chat', id: 'c', title: 'Chat', pinned: false, mode: 'build', connectorIds: [], disabledConnectorIds: [], createdAt: time, updatedAt: time},
  messages: [{type: 'message', id: 'm', chatId: 'c', runId: 'r', role: 'user', parts: [{type: 'text', text: 'Hello'}], createdAt: time, updatedAt: time}],
});

/** A process that can "die": once dead, nothing it does reaches storage or the event log. */
function process(dieWhen: (e: RunEventPayload) => boolean = () => false) {
  let saved: AgentCheckpoint | undefined;
  let dead = false;
  let n = 0;
  const prefix = crypto.randomUUID();
  const events: RunEventPayload[] = [];
  const ports: AgentPorts = {
    save: async (_u, cp) => { if (!dead) saved = structuredClone(cp); },
    emit: async (_u, _r, e) => {
      if (dead) throw new Error('dead');
      RunEventPayloadSchema.parse(e);
      if (dieWhen(e)) { dead = true; throw new Error('process crashed'); }
      events.push(structuredClone(e));
      return events.length;
    },
    isCancelled: async () => false,
    now: () => time,
    id: () => `${prefix}-${++n}`,
    sleep: async () => {},
  };
  return {ports, events, get saved() { return saved!; }, kill() { dead = true; }};
}

describe('crash recovery (REV-A1 P1 runner.ts:51 transcript delivery)', () => {
  it('delivers a message saved in the checkpoint but never emitted before the crash', async () => {
    const first = process(e => e.type === 'messages.committed' && e.messages.some(m => m.role === 'assistant'));
    await new AgentRunner({ports: first.ports, provider: createScriptedProvider('tools'), tools: scriptedTools()}).run(input()).catch(() => {});
    const crashed = first.saved;
    const assistant = crashed.messages.find(m => m.role === 'assistant')!;
    expect(assistant).toBeDefined();
    expect(crashed.outbox.map(m => m.id)).toContain(assistant.id);

    const second = process();
    const done = await new AgentRunner({ports: second.ports, provider: createScriptedProvider('tools'), tools: scriptedTools()}).advance(crashed);
    expect(done.run.error ?? done.run.outcome).toBe('completed');
    const delivered = second.events.flatMap(e => (e.type === 'messages.committed' ? e.messages.map(m => m.id) : []));
    expect(delivered).toContain(assistant.id);
    expect(done.outbox).toEqual([]);
  });
});

describe('interrupted tool replay (REV-A1 P0 idempotency per toolCallId)', () => {
  function tools(counter: {n: number}, die: () => void, traits: AgentTool['spec']['traits']): AgentTool[] {
    return scriptedTools().map(t => t.spec.name === 'local_echo'
      ? {...t, spec: {...t.spec, traits}, execute: async () => { counter.n++; die(); return textResult('done'); }}
      : t);
  }
  it('does not re-run a side-effecting tool that started before a crash', async () => {
    const counter = {n: 0};
    const first = process();
    await new AgentRunner({ports: first.ports, provider: createScriptedProvider('tools'), tools: tools(counter, () => first.kill(), ['sandboxed'])}).run(input()).catch(() => {});
    expect(counter.n).toBe(1);
    const call = Object.values(first.saved.calls)[0]!;
    expect(call.started).toBe(true);
    expect(call.result).toBeUndefined();

    const second = process();
    const done = await new AgentRunner({ports: second.ports, provider: createScriptedProvider('tools'), tools: tools(counter, () => {}, ['sandboxed'])}).advance(first.saved);
    expect(counter.n).toBe(1);
    expect(done.run.error ?? done.run.outcome).toBe('completed');
    expect(JSON.stringify(Object.values(done.calls)[0]!.result)).toContain('was not retried automatically');
  });
  it('re-runs an idempotent/read-only tool after a crash', async () => {
    const counter = {n: 0};
    const first = process();
    await new AgentRunner({ports: first.ports, provider: createScriptedProvider('tools'), tools: tools(counter, () => first.kill(), ['readOnly'])}).run(input()).catch(() => {});
    const second = process();
    const done = await new AgentRunner({ports: second.ports, provider: createScriptedProvider('tools'), tools: tools(counter, () => {}, ['readOnly'])}).advance(first.saved);
    expect(counter.n).toBe(2);
    expect(Object.values(done.calls)[0]!.result?.isError).toBe(false);
  });
});
