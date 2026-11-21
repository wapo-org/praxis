import {expect, it} from 'vitest';
import {AgentRunner} from './runner.js';
import {CapabilitiesSchema} from '@praxis/protocol';
import type {ModelProvider, RunInput} from './types.js';

it('the active runner preserves connector-note bytes across rediscovery order', async () => {
  const systems: string[] = [];
  const time = '2026-11-17T00:00:00.000Z';
  const input: RunInput = {
    userId: 'user', messages: [],
    run: {type: 'run', id: 'run', chatId: 'chat', status: 'queued', createdAt: time, updatedAt: time, lastEventId: 0},
    chat: {type: 'chat', id: 'chat', title: 'Chat', pinned: false, mode: 'build', connectorIds: [], disabledConnectorIds: [], createdAt: time, updatedAt: time},
    setup: {type: 'conversation.setup', system: 'Stable\n\nConnected tools:\n- old', tools: [], skillCatalog: '', connectorIds: [], createdAt: time},
  };
  for (const toolNotes of [['z', 'a', 'a'], ['a', 'z']]) {
    const provider: ModelProvider = {capabilities: CapabilitiesSchema.parse({}), async *stream(request) {
      systems.push(request.system);
      yield {type: 'completed', response: {parts: [{type: 'text', text: 'done'}], stop: 'endTurn', raw: undefined,
        usage: {type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0}}};
    }};
    const runner = new AgentRunner({provider, toolNotes, ports: {
      save: async () => {}, emit: async () => {}, isCancelled: async () => false, now: () => time,
    }});
    await runner.run(input);
  }
  expect(systems).toHaveLength(2);
  expect(systems[0]).toBe(systems[1]);
});
