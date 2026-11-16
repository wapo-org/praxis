import {cancellationKey} from '../run-keys.js';
import {expect, it} from 'vitest';
import fc from 'fast-check';
import {RunEventPayloadSchema, type RunSnapshot, type Message} from '@praxis/protocol';
import {AgentRunner, createScriptedProvider, type ModelProvider} from '@praxis/agent';
import {ApiService} from '../service.js';
import {createLocalAdapters} from '../local-memory.js';
import {localDriver} from '../runtime.js';

const RUNS_MAX = 30;
const TURNS_MAX = 6;
const RETRIES_MAX = 5;
const USER = 'local-user';
const CHAT = 'welcome';

async function fixture() {
  const service = new ApiService(createLocalAdapters(), true);
  service.driver = localDriver(service);
  await service.seed(USER);
  return service;
}

it('ClientTurnDedup: concurrent retries and completed retries produce one user turn; conflicting bodies fail', async () => {
  await fc.assert(fc.asyncProperty(
    fc.string({minLength: 1, maxLength: 40}),
    fc.integer({min: 2, max: RETRIES_MAX}),
    async (text, retries) => {
      const service = await fixture();
      const input = {type: 'run.start' as const, chatId: CHAT, text, webSearch: false, attachmentIds: [],
        script: 'text' as const, clientTurnId: crypto.randomUUID()};
      const runs = await Promise.all(Array.from({length: retries}, () => service.start(USER, input)));
      await service.drain();
      expect(new Set(runs.map(r => r.id)).size).toBe(1);
      expect((await service.start(USER, input)).id).toBe(runs[0]!.id);
      await expect(service.start(USER, {...input, text: text + '!'})).rejects.toMatchObject({status: 409});
      const messages = await service.list<Message>(USER, 'message', CHAT);
      const assistant = messages.filter(m => m.role === 'assistant');
      const replayEvent = {type: 'messages.committed' as const, messages: structuredClone(assistant)};
      const first = await service.emit(USER, runs[0]!.id, structuredClone(replayEvent));
      const second = await service.emit(USER, runs[0]!.id, structuredClone(replayEvent));
      expect(first).toBe(second);
      const replayed = await service.list<Message>(USER, 'message', CHAT);
      expect(replayed).toEqual(messages);
      expect(messages.filter(m => m.role === 'user' && m.clientTurnId === input.clientTurnId)).toHaveLength(1);
      expect(messages.map(m => m.sequence).sort((a, b) => a! - b!)).toEqual(messages.map((_, i) => i + 1));
    },
  ), {numRuns: RUNS_MAX});
});

it('OrderedPrefix: truncate deletes the selected turn and its suffix, preserving the exact prefix', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({min: 1, max: TURNS_MAX}), fc.nat(), async (turns, choice) => {
      const service = await fixture();
      const turnIds: string[] = [];
      for (let i = 0; i < turns; i++) {
        const clientTurnId = crypto.randomUUID();
        turnIds.push(clientTurnId);
        await service.start(USER, {type: 'run.start', chatId: CHAT, text: `turn ${i}`,
          webSearch: false, attachmentIds: [], script: 'text', clientTurnId});
        await service.drain();
      }
      const before = (await service.list<Message>(USER, 'message', CHAT)).sort((a, b) => a.sequence! - b.sequence!);
      const cutTurn = choice % turns;
      const cut = before.findIndex(m => m.clientTurnId === turnIds[cutTurn]);
      const result = await service.truncate(USER, CHAT, turnIds[cutTurn]!);
      const after = (await service.list<Message>(USER, 'message', CHAT)).sort((a, b) => a.sequence! - b.sequence!);
      expect(after).toEqual(before.slice(0, cut));
      expect(result.removedMessageIds).toEqual(before.slice(cut).map(m => m.id));
      const restarted = await service.start(USER, {type: 'run.start', chatId: CHAT, text: `turn ${cutTurn}`,
        webSearch: false, attachmentIds: [], script: 'text', clientTurnId: crypto.randomUUID()});
      await service.drain();
      expect(result.removedRunIds).not.toContain(restarted.id);
      const continued = (await service.list<Message>(USER, 'message', CHAT)).sort((a, b) => a.sequence! - b.sequence!);
      expect(continued.slice(0, cut)).toEqual(before.slice(0, cut));
      expect(continued.map(m => m.sequence)).toEqual(continued.map((_, i) => i + 1));
    },
  ), {numRuns: RUNS_MAX});
});


it('StopPrefix / CancelFence: cancelling between arbitrary chunks keeps only the accepted snapshot prefix', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.string({minLength: 1, maxLength: 20}), {minLength: 2, maxLength: 10}),
    fc.nat(), async (chunks, choice) => {
      const stopAt = 1 + choice % (chunks.length - 1);
      const service = await fixture();
      let accepted = 0;
      const provider: ModelProvider = {
        capabilities: createScriptedProvider('text').capabilities,
        async *stream() {
          for (const text of chunks) yield {type: 'text' as const, index: 0, text};
          yield {type: 'completed' as const, response: {parts: [{type: 'text', text: chunks.join('')}],
            stop: 'endTurn', usage: {type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0}}};
        },
      };
      service.driver = {
        resume: async () => {},
        start: async (userId, run, chat, messages) => {
          const runner = new AgentRunner({provider, ports: {
            save: async () => {},
            isCancelled: async () => Boolean(await service.adapters.kv.get(cancellationKey(userId, run.id))),
            emit: async (_user, _run, event) => {
              const id = await service.emit(userId, run.id, event);
              if (event.type === 'text.delta' && ++accepted === stopAt) await service.cancel(userId, run.id);
              return id;
            },
          }});
          await runner.run({userId, run, chat, messages});
        },
      };
      const run = await service.start(USER, {type: 'run.start', chatId: CHAT, text: 'stop test', webSearch: false, attachmentIds: []});
      await service.drain();
      const snapshot = await service.require<RunSnapshot>(USER, 'snapshot', run.id);
      expect(snapshot.run.status).toBe('cancelled');
      expect(snapshot.blocks.map(b => b.text).join('')).toBe(chunks.slice(0, stopAt).join(''));
      expect(snapshot.blocks.every(b => b.finished)).toBe(true);
      expect(accepted).toBe(stopAt);
      await service.cancel(USER, run.id);
      const events = await service.adapters.events.read(USER, `run:${run.id}`, 0, 100);
      expect(events.filter(e => RunEventPayloadSchema.parse(e.payload.event).type === 'run.finished')).toHaveLength(1);
    },
  ), {numRuns: RUNS_MAX});
});
