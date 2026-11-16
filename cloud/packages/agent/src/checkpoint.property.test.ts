import {expect, it} from 'vitest';
import fc from 'fast-check';
import {AgentRunner, createScriptedProvider, type AgentPorts, type RunInput} from './index.js';
import type {Message} from '@praxis/protocol';

const RUNS_MAX = 50;
const REPLAYS_MAX = 8;
const TIME = '2026-11-16T12:00:00.000Z';
const input = (): RunInput => ({
  userId: 'u',
  run: {type: 'run', id: 'r', chatId: 'c', status: 'queued', createdAt: TIME, updatedAt: TIME, lastEventId: 0},
  chat: {type: 'chat', id: 'c', title: 'Chat', pinned: false, mode: 'build', connectorIds: [],
    disabledConnectorIds: [], createdAt: TIME, updatedAt: TIME},
  messages: [],
});

it('CheckpointReplayStable / TurnCommitOnce: replaying an outbox retains message identity and terminal retries do no work', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 1, max: REPLAYS_MAX}), async replays => {
    const persisted = new Map<string, Message>();
    const deliveries: string[] = [];
    let ids = 0;
    const ports: AgentPorts = {
      save: async () => {},
      emit: async (_user, _run, event) => {
        if (event.type === 'messages.committed') {
          for (const message of event.messages) {
            persisted.set(message.id, message);
            deliveries.push(message.id);
          }
        }
      },
      isCancelled: async () => false, now: () => TIME, id: () => `message-${++ids}`,
    };
    const runner = new AgentRunner({ports, provider: createScriptedProvider('text')});
    const done = await runner.run(input());
    expect(done.run.status).toBe('completed');
    const baseline = structuredClone(done.messages);
    const pendingDelivery = {...done, outbox: structuredClone(done.messages)};
    for (let i = 0; i < replays; i++) {
      const replayed = await runner.advance(structuredClone(pendingDelivery));
      expect(replayed.outbox).toEqual([]);
      expect(replayed.messages).toEqual(baseline);
      expect(replayed.iteration).toBe(done.iteration);
    }
    expect([...persisted.values()]).toEqual(baseline);
    expect(new Set(deliveries).size).toBe(baseline.length);
    expect(deliveries.length).toBe(baseline.length * (replays + 1));
  }), {numRuns: RUNS_MAX});
});
