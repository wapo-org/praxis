import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {RunSnapshotSchema, type Message} from '@praxis/protocol';
import {createApp} from '../app.js';
import {createLocalAdapters} from '../local-memory.js';
import {createExecutionDriver, type ExecutionFeatures} from '../execution.js';
import {ApiService} from '../service.js';
import type {FeatureTool} from '../contracts.js';
import {connectKey, delta, fakeOpenRouter} from './harness.js';

const fakeOpenAI = (turns: string[][]) => fakeOpenRouter(turns, [{id: 'fake-model'}]);

function setup(fetcher: typeof fetch, features?: ExecutionFeatures) {
  const service = new ApiService(createLocalAdapters(), true);
  service.driver = createExecutionDriver({service, fetcher, ...(features ? {features} : {})});
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {service, req};
}

async function realChat(f: ReturnType<typeof setup>, connect = true) {
  if (connect) await connectKey(f.req);
  const chat = await (await f.req('/v1/chats', {type: 'chat.input', title: 'Real', modelId: 'fake-model'})).json();
  return {chat};
}

describe('execution driver with a real HTTP provider', () => {
  it('streams a real provider turn, freezes the setup and announces the mode once', async () => {
    const fake = fakeOpenAI([[delta({content: 'Hello '}), delta({content: 'world'}), delta({}, 'stop')], [delta({content: 'Again'}), delta({}, 'stop')]]);
    const f = setup(fake.fetcher);
    const {chat} = await realChat(f);
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'Hi'})).json();
    await f.service.drain();
    const snapshot = RunSnapshotSchema.parse(await (await f.req(`/v1/runs/${run.id}/snapshot`)).json());
    expect(snapshot.run.status).toBe('completed');
    const messages: Message[] = (await (await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(messages[0]!.parts[0]).toEqual({type: 'note', text: 'Current mode: build.'});
    expect(messages[1]!.parts.find(p => p.type === 'text')?.text).toBe('Hello world');
    expect(JSON.stringify(fake.requests[0])).toContain('You are Praxis, an assistant running in a mobile app.');
    expect(fake.requests[0].model).toBe('fake-model');

    const second = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'More'})).json();
    await f.service.drain();
    const all: Message[] = (await (await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(all.filter(m => m.runId === second.id && m.role === 'user')[0]!.parts.some(p => p.type === 'note')).toBe(false);
    expect(fake.requests[1].messages[0]).toEqual(fake.requests[0].messages[0]);
  });

  it('refuses to start without a connected key, before anything is sent to OpenRouter', async () => {
    const fake = fakeOpenAI([]);
    const f = setup(fake.fetcher);
    const {chat} = await realChat(f, false);
    const res = await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'Hi'});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('model_key_missing');
    expect(fake.requests).toHaveLength(0);
    expect(await f.service.list('local-user', 'run')).toHaveLength(0);
  });

  it('runs feature tools through the loop policy and returns results to the model', async () => {
    const calls: unknown[] = [];
    const echo: FeatureTool = {
      name: 'echo', description: 'Echo', inputSchema: {type: 'object', properties: {x: {type: 'number'}}},
      source: {type: 'builtin'}, traits: ['readOnly'],
      async execute(args) { calls.push(args); return {content: [{type: 'text', text: 'echoed'}], isError: false}; },
    };
    const fake = fakeOpenAI([
      [delta({tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'echo', arguments: '{"x":1}'}}]}), delta({}, 'tool_calls')],
      [delta({content: 'Done'}), delta({}, 'stop')],
    ]);
    const f = setup(fake.fetcher, {tools: async () => [echo]});
    const {chat} = await realChat(f);
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'Use echo'})).json();
    await f.service.drain();
    const snapshot = RunSnapshotSchema.parse(await (await f.req(`/v1/runs/${run.id}/snapshot`)).json());
    expect(snapshot.run.status).toBe('completed');
    expect(calls).toEqual([{x: 1}]);
    expect(fake.requests[0].tools.map((t: any) => t.function.name)).toEqual(['read_tool_output', 'echo']);
    expect(JSON.stringify(fake.requests[1].messages)).toContain('echoed');
  });
});

describe('slice budget', () => {
  it('parks a run as continuing when the budget is spent and finishes it in later slices', async () => {
    const service = new ApiService(createLocalAdapters(), true);
    let now = 0;
    service.driver = createExecutionDriver({service, budgetMs: 500, clock: () => (now += 1000)});
    const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64')});
    const res = await app.request('/v1/runs', {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify({type: 'run.start', chatId: 'welcome', text: 'Hi', script: 'tools'})});
    const run = await res.json();
    for (let i = 0; i < 20; i++) await service.drain();
    const events = await service.adapters.events.read('local-user', `run:${run.id}`, 0, 500);
    const types = events.map(e => (e.payload.event as {type: string; reason?: string}));
    expect(types.filter(e => e.type === 'run.parked' && e.reason === 'continuation').length).toBeGreaterThanOrEqual(1);
    expect(types.at(-1)).toMatchObject({type: 'run.finished', outcome: 'completed'});
  });
});

describe('background work never rejects unobserved', () => {
  it('logs instead of rejecting when the failure handler itself fails (run row deleted mid-run)', async () => {
    const service = new ApiService(createLocalAdapters(), true);
    const logged: string[] = [];
    service.onBackgroundError = runId => { logged.push(runId); };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    // Forces failure path inside catch handler when run is missing.
    await service.adapters.store.put('u', 'run', 'r1', {type: 'run', id: 'r1', chatId: 'c', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastEventId: 0});
    service.emit = async () => { throw new Error('event store down'); };
    service.enqueue('u', 'r1', async () => { throw new Error('task failed'); });
    await service.drain();
    await new Promise(r => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    expect(logged).toEqual(['r1']);
    expect(unhandled).toEqual([]);
  });
});
