import {describe, expect, it, vi} from 'vitest';
import {inspect} from 'node:util';
import {randomBytes} from 'node:crypto';
import {CatalogModelSchema, DEFAULT_MODEL_ID, ModelKeySchema, RECOMMENDED_MODELS, RunSnapshotSchema, type Run} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {CATALOG_RETRY_MS, CATALOG_TTL_MS, capabilitiesOf, parseCatalogModel} from '../openrouter/index.js';
import {createPraxisApp, jsonLog} from '../server.js';
import {TITLE_SYSTEM} from '../title-generation.js';
import {unseal} from '../secrets.js';
import {catalogEntry, delta, type FakeModel} from './harness.js';

const KEY_A = 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaAAAA';
const KEY_B = 'sk-or-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbBBBB';
const PKCE_KEY = 'sk-or-v1-pkcepkcepkcepkcepkcepkcePKCE';
const VERIFIER = 'v'.repeat(64);
const sse = (frames: string[]) => new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
const usageChunk = (usage: object) => JSON.stringify({choices: [{index: 0, delta: {content: ''}, finish_reason: 'stop'}], usage});

/** A scriptable OpenRouter: every call is recorded with its URL, bearer token and JSON body. */
function openRouter() {
  const calls: {url: string; method: string; authorization: string | null; body: any}[] = [];
  const state = {
    models: [{id: 'vendor/alpha', name: 'Alpha', tools: true, vision: true, reasoning: true}, {id: 'vendor/blind', name: 'Blind', tools: false}, {id: DEFAULT_MODEL_ID, name: 'Default', tools: true}] as FakeModel[],
    modelsDown: false,
    /** Keys OpenRouter accepts → the key info it reports. */
    keys: new Map<string, object>([[KEY_A, {label: 'sk-or-v1-aaa...AAA', limit: 25, limit_remaining: 19.5}], [KEY_B, {label: 'sk-or-v1-bbb...BBB', limit: null, limit_remaining: null}], [PKCE_KEY, {label: 'Praxis', limit: 5, limit_remaining: 5}]]),
    codes: new Map<string, string>([['good-code', VERIFIER]]),
    chat: (_body: any, _authorization: string | null): Response => sse([delta({content: 'ok'}), delta({}, 'stop')]),
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://openrouter.ai/api/v1/')) throw new Error(`Unexpected outbound request to ${url}`);
    const authorization = new Headers(init?.headers).get('authorization');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({url, method: init?.method ?? 'GET', authorization, body});
    const path = url.slice('https://openrouter.ai/api/v1'.length);
    if (path === '/models') return state.modelsDown ? Response.json({error: {code: 503, message: 'Service temporarily unavailable'}}, {status: 503}) : Response.json({data: state.models.map(catalogEntry)});
    if (path === '/key') {
      const info = state.keys.get((authorization ?? '').replace(/^Bearer /, ''));
      return info ? Response.json({data: info}) : Response.json({error: {code: 401, message: 'User not found.'}}, {status: 401});
    }
    if (path === '/auth/keys') {
      // Codes are single use, like OpenRouter's.
      const expected = state.codes.get(body.code);
      state.codes.delete(body.code);
      if (!expected || expected !== body.code_verifier || body.code_challenge_method !== 'S256') return Response.json({error: {code: 400, message: 'Invalid code or code_verifier'}}, {status: 400});
      return Response.json({key: PKCE_KEY, user_id: 'user_1'});
    }
    if (path === '/chat/completions') return state.chat(body, authorization);
    return Response.json({error: {code: 404, message: 'Not found'}}, {status: 404});
  }) as typeof fetch;
  return {fetcher, calls, state};
}

function setup(options: {clock?: () => number} = {}) {
  const or = openRouter();
  const encryptionKey = randomBytes(32).toString('base64');
  const adapters = createLocalAdapters();
  const {app, service} = createPraxisApp({adapters, local: true, encryptionKey, fetcher: or.fetcher, modules: localModules('http://127.0.0.1:8787'), ...options});
  const bodies: string[] = [];
  /** `as` signs in a separate dev user. Every response body is kept for the leak scan. */
  const client = async (as?: string) => {
    const token = as ? (await (await app.request('/v1/auth/dev', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'auth.dev', userId: as})})).json()).bearerToken as string : 'dev-local';
    return async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const response = await app.request(path, {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
      bodies.push(await response.clone().text());
      return response;
    };
  };
  const turn = async (req: Awaited<ReturnType<typeof client>>, input: {modelId?: string; chatModelId?: string; text?: string}) => {
    const chat = await (await req('/v1/chats', {type: 'chat.input', ...(input.chatModelId ? {modelId: input.chatModelId} : {modelId: 'vendor/alpha'})})).json();
    const started = await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: input.text ?? 'Hi', ...(input.modelId ? {modelId: input.modelId} : {})});
    const run = await started.json();
    await service.drain();
    if (started.status !== 202) return {started, run, chat, snapshot: undefined};
    return {started, run, chat, snapshot: RunSnapshotSchema.parse(await (await req(`/v1/runs/${run.id}/snapshot`)).json())};
  };
  return {or, app, service, adapters, encryptionKey, bodies, client, turn};
}
/** Run turns only: title requests share the endpoint and the stream but carry the title system prompt. */
const chatCalls = (f: ReturnType<typeof setup>) => f.or.calls.filter(c => c.url.endsWith('/chat/completions') && c.body.messages?.[0]?.content !== TITLE_SYSTEM);

describe('connecting a key', () => {
  it('paste: validates against key info, stores it sealed and returns only the masked record', async () => {
    const f = setup(), req = await f.client();
    expect((await req('/v1/model-key')).status).toBe(404);
    const res = await req('/v1/model-key', {method: 'paste', apiKey: `  ${KEY_A}\n`});
    expect(res.status).toBe(200);
    const record = ModelKeySchema.parse(await res.json());
    expect(record).toMatchObject({type: 'modelKey', maskedKey: '••••AAAA', label: 'sk-or-v1-aaa...AAA', limit: 25, limitRemaining: 19.5});
    expect(record.lastError).toBeUndefined();
    expect(f.or.calls).toEqual([{url: 'https://openrouter.ai/api/v1/key', method: 'GET', authorization: `Bearer ${KEY_A}`, body: undefined}]);
    const row = (await f.adapters.store.get('local-user', 'modelKey', 'current'))!;
    expect(JSON.stringify(row)).not.toContain(KEY_A);
    expect(unseal(String(row.value.sealed), 'local-user', 'modelKey', f.encryptionKey)).toBe(KEY_A);
    // The seal is bound to its owner: the same blob does not open as another user's.
    expect(() => unseal(String(row.value.sealed), 'someone-else', 'modelKey', f.encryptionKey)).toThrow();
    // Unsealed, the key stays wrapped: only reveal() gives the value.
    const unsealed = await f.service.models!.keys.reveal('local-user');
    expect(unsealed.reveal()).toBe(KEY_A);
    expect(`${unsealed} ${JSON.stringify({unsealed})} ${inspect({unsealed})}`).not.toContain(KEY_A);
    expect(await (await req('/v1/model-key')).json()).toEqual(record);
  });

  it('PKCE: exchanges the code with its verifier, then stores the returned key', async () => {
    const f = setup(), req = await f.client();
    const res = await req('/v1/model-key', {method: 'pkce', code: 'good-code', codeVerifier: VERIFIER});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({maskedKey: '••••PKCE', label: 'Praxis', limit: 5, limitRemaining: 5});
    expect(f.or.calls[0]).toEqual({url: 'https://openrouter.ai/api/v1/auth/keys', method: 'POST', authorization: null, body: {code: 'good-code', code_verifier: VERIFIER, code_challenge_method: 'S256'}});
    const row = (await f.adapters.store.get('local-user', 'modelKey', 'current'))!;
    expect(unseal(String(row.value.sealed), 'local-user', 'modelKey', f.encryptionKey)).toBe(PKCE_KEY);
    // A replayed code is refused by OpenRouter and reported clearly; the stored key is untouched.
    const replay = await req('/v1/model-key', {method: 'pkce', code: 'good-code', codeVerifier: VERIFIER});
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({code: 'model_key_rejected', message: expect.stringContaining('Invalid code or code_verifier')});
    expect((await req('/v1/model-key')).status).toBe(200);
  });

  it('PKCE: a wrong verifier is rejected and nothing is stored', async () => {
    const f = setup(), req = await f.client();
    const res = await req('/v1/model-key', {method: 'pkce', code: 'good-code', codeVerifier: 'x'.repeat(64)});
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('model_key_rejected');
    expect(await f.adapters.store.get('local-user', 'modelKey', 'current')).toBeNull();
  });

  it('rejects a key OpenRouter does not know with 400 and its message, and a non-OpenRouter key without sending it anywhere', async () => {
    const f = setup(), req = await f.client();
    const unknown = await req('/v1/model-key', {method: 'paste', apiKey: 'sk-or-v1-not-a-real-key-0000'});
    expect(unknown.status).toBe(400);
    const error = await unknown.json();
    expect(error).toMatchObject({type: 'error', code: 'model_key_rejected', message: expect.stringContaining('User not found.')});
    expect(JSON.stringify(error)).not.toContain('not-a-real-key');
    const before = f.or.calls.length;
    const foreign = await req('/v1/model-key', {method: 'paste', apiKey: 'sk-proj-openai-key-123456'});
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({code: 'model_key_rejected', message: expect.stringContaining('not an OpenRouter key')});
    expect(f.or.calls.length).toBe(before);
    expect(await f.adapters.store.get('local-user', 'modelKey', 'current')).toBeNull();
    expect((await req('/v1/model-key', {method: 'oauth', token: 'x'})).status).toBe(400);
  });

  it('answers 502 when OpenRouter cannot be reached, never 400', async () => {
    const f = setup();
    const failing = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: f.encryptionKey, fetcher: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch});
    const res = await failing.app.request('/v1/model-key', {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify({method: 'paste', apiKey: KEY_A})});
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('openrouter_unavailable');
    expect((await failing.app.request('/v1/model-key', {headers: {Authorization: 'Bearer dev-local'}})).status).toBe(404);
  });

  it('check refreshes label, limit and remaining credit; a revoked key is marked, then cleared by a good check', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    f.or.state.keys.set(KEY_A, {label: 'Renamed', limit: 25, limit_remaining: 3.25});
    expect(await (await req('/v1/model-key/check', {})).json()).toMatchObject({label: 'Renamed', limit: 25, limitRemaining: 3.25});
    const saved = f.or.state.keys.get(KEY_A)!;
    f.or.state.keys.delete(KEY_A);
    const revoked = await req('/v1/model-key/check', {});
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({maskedKey: '••••AAAA', lastError: 'User not found.'});
    expect((await (await req('/v1/bootstrap')).json()).modelKey.lastError).toBe('User not found.');
    f.or.state.keys.set(KEY_A, saved);
    expect((await (await req('/v1/model-key/check', {})).json()).lastError).toBeUndefined();
    const other = await f.client('nobody');
    expect((await other('/v1/model-key/check', {})).status).toBe(400);
  });

  it('delete removes the key; the next run asks for one', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    expect((await req('/v1/model-key', undefined, 'DELETE')).status).toBe(200);
    expect((await req('/v1/model-key')).status).toBe(404);
    expect((await (await req('/v1/bootstrap')).json()).modelKey).toBeUndefined();
    expect((await f.adapters.store.get('local-user', 'modelKey', 'current'))?.deleted).toBe(true);
    expect((await req('/v1/model-key', undefined, 'DELETE')).status).toBe(404);
    const {started, run} = await f.turn(req, {});
    expect(started.status).toBe(400);
    expect(run.code).toBe('model_key_missing');
  });
});

describe('the model catalogue', () => {
  it('lists entries with context window, price and capabilities from the OpenRouter entry, and needs no key', async () => {
    const f = setup(), req = await f.client();
    const items = (await (await req('/v1/models')).json()).items;
    const alpha = items.find((m: any) => m.id === 'vendor/alpha');
    expect(CatalogModelSchema.parse(alpha)).toEqual({type: 'catalogModel', id: 'vendor/alpha', name: 'Alpha', contextLength: 128000, maxOutput: 16000, pricing: {prompt: '0.000003', completion: '0.000015'}, capabilities: {tools: true, reasoning: true, images: true, files: false}});
    expect(alpha).toMatchObject({pinned: false, favorite: false, recommended: false});
    expect(items.find((m: any) => m.id === 'vendor/blind').capabilities).toEqual({tools: false, reasoning: false, images: false, files: false});
    expect(f.or.calls).toEqual([{url: 'https://openrouter.ai/api/v1/models', method: 'GET', authorization: null, body: undefined}]);
  });

  it('puts recommended models first in the curated order and searches id and name', async () => {
    const f = setup(), req = await f.client();
    f.or.state.models = [{id: 'zeta/last', name: 'Aardvark'}, {id: RECOMMENDED_MODELS[1], name: 'Second pick'}, {id: RECOMMENDED_MODELS[0], name: 'First pick'}, {id: 'vendor/Mixed-Case', name: 'Other'}];
    const ids = (await (await req('/v1/models')).json()).items.filter((m: any) => !m.id.startsWith('scripted')).map((m: any) => [m.id, m.recommended]);
    expect(ids).toEqual([[RECOMMENDED_MODELS[0], true], [RECOMMENDED_MODELS[1], true], ['zeta/last', false], ['vendor/Mixed-Case', false]]);
    const search = async (q: string) => (await (await req(`/v1/models?q=${encodeURIComponent(q)}`)).json()).items.map((m: any) => m.id);
    expect(await search('aardvark')).toEqual(['zeta/last']);
    expect(await search('mixed-case')).toEqual(['vendor/Mixed-Case']);
    expect(await search('no such model')).toEqual([]);
  });

  it('is fetched once per hour, shared across users, and refreshed after the hour', async () => {
    let now = 1_000_000;
    const f = setup({clock: () => now}), a = await f.client(), b = await f.client('user-b');
    const fetches = () => f.or.calls.filter(c => c.url.endsWith('/models')).length;
    await a('/v1/models'); await b('/v1/models'); await a('/v1/models?q=alpha');
    expect(fetches()).toBe(1);
    now += CATALOG_TTL_MS - 1;
    await a('/v1/models');
    expect(fetches()).toBe(1);
    f.or.state.models = [...f.or.state.models, {id: 'vendor/new', name: 'New'}];
    now += 2;
    expect((await (await b('/v1/models?q=vendor/new')).json()).items).toHaveLength(1);
    expect(fetches()).toBe(2);
  });

  it('serves the last good copy when a refresh fails, retries after a minute, and says so when there has never been one', async () => {
    let now = 5_000_000;
    const f = setup({clock: () => now}), req = await f.client();
    const fetches = () => f.or.calls.filter(c => c.url.endsWith('/models')).length;
    const names = async () => (await (await req('/v1/models?q=vendor')).json()).items.map((m: any) => m.id);
    const good = await names();
    expect(good).toContain('vendor/alpha');
    f.or.state.modelsDown = true;
    now += CATALOG_TTL_MS + 1;
    expect(await names()).toEqual(good);
    expect(fetches()).toBe(2);
    expect(await names()).toEqual(good); // within the retry window: served without another attempt
    expect(fetches()).toBe(2);
    now += CATALOG_RETRY_MS + 1;
    f.or.state.modelsDown = false;
    f.or.state.models = [{id: 'vendor/only', name: 'Only'}];
    expect(await names()).toEqual(['vendor/only']);

    // Production (no scripted entries) with no copy at all: a clear 503, never an invented list.
    const cold = openRouter();
    cold.state.modelsDown = true;
    const {OpenRouterModels} = await import('../openrouter/index.js');
    const {ApiService} = await import('../service.js');
    const models = new OpenRouterModels(new ApiService(createLocalAdapters(), false), f.encryptionKey, cold.fetcher);
    await expect(models.list('u')).rejects.toMatchObject({status: 503, code: 'catalog_unavailable'});
  });

  it('skips entries that cannot chat and derives run capabilities from the entry alone', () => {
    expect(parseCatalogModel({id: 'img/gen', name: 'Image only', context_length: 4096, architecture: {input_modalities: ['text'], output_modalities: ['image']}, pricing: {}})).toBeNull();
    expect(parseCatalogModel({id: 'no/context', name: 'X', architecture: {output_modalities: ['text']}})).toBeNull();
    expect(parseCatalogModel({name: 'no id', context_length: 1})).toBeNull();
    const model = parseCatalogModel(catalogEntry({id: 'v/m', tools: true, vision: true, documents: true, reasoning: true}))!;
    expect(capabilitiesOf(model)).toMatchObject({tools: true, parallelToolCalls: true, vision: true, documents: true, reasoningEffort: true, serverWebSearch: false});
    expect(capabilitiesOf(parseCatalogModel(catalogEntry({id: 'v/plain', tools: false}))!)).toMatchObject({tools: false, vision: false, documents: false, reasoningEffort: false});
  });
});

describe('runs on the user\'s own key', () => {
  it('sends user A\'s key for A and user B\'s key for B, never the other way round', async () => {
    const f = setup(), a = await f.client('user-a'), b = await f.client('user-b');
    await a('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    await b('/v1/model-key', {method: 'paste', apiKey: KEY_B});
    f.or.state.chat = (body, _authorization) => sse([delta({content: `for ${body.messages.at(-1).content}`}), delta({}, 'stop'), usageChunk({prompt_tokens: 1, completion_tokens: 1})]);
    expect((await f.turn(a, {text: 'from A'})).snapshot?.run.status).toBe('completed');
    expect((await f.turn(b, {text: 'from B'})).snapshot?.run.status).toBe('completed');
    expect((await f.turn(a, {text: 'from A again'})).snapshot?.run.status).toBe('completed');
    const sent = chatCalls(f).map(c => [JSON.stringify(c.body.messages.at(-1).content).includes('from A') ? 'A' : 'B', c.authorization]);
    expect(sent).toEqual([['A', `Bearer ${KEY_A}`], ['B', `Bearer ${KEY_B}`], ['A', `Bearer ${KEY_A}`]]);
    expect(chatCalls(f).every(c => c.url === 'https://openrouter.ai/api/v1/chat/completions' && c.body.model === 'vendor/alpha')).toBe(true);
  });

  it('takes tools, images and reasoning from the catalogue entry of the chosen model', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    const able = await (await req('/v1/chats', {type: 'chat.input', modelId: 'vendor/alpha', effort: 'high'})).json();
    await req('/v1/runs', {type: 'run.start', chatId: able.id, text: 'Hi'}); await f.service.drain();
    const blind = await (await req('/v1/chats', {type: 'chat.input', modelId: 'vendor/blind', effort: 'high'})).json();
    await req('/v1/runs', {type: 'run.start', chatId: blind.id, text: 'Hi'}); await f.service.drain();
    const [first, second] = chatCalls(f).map(c => c.body);
    expect(first.tools.length).toBeGreaterThan(0);
    expect(first.reasoning).toEqual({effort: 'high'});
    expect(first.usage).toEqual({include: true});
    expect(first.max_tokens).toBe(8192);
    expect(second.tools).toBeUndefined();
    expect(second.reasoning).toBeUndefined();
    expect(JSON.stringify(second.messages[0])).toContain('Tool use is unavailable');
  });

  it('fails fast with model_key_missing when no key is connected: no run, nothing sent', async () => {
    const f = setup(), req = await f.client();
    const {started, run} = await f.turn(req, {});
    expect(started.status).toBe(400);
    expect(run).toMatchObject({type: 'error', code: 'model_key_missing'});
    expect(chatCalls(f)).toHaveLength(0);
    expect(await f.service.list('local-user', 'run')).toEqual([]);
  });

  it('401 ends the run as model_key_invalid and marks the key record', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    f.or.state.chat = () => Response.json({error: {code: 401, message: 'User not found.'}}, {status: 401});
    const {snapshot, run} = await f.turn(req, {});
    expect(snapshot?.run).toMatchObject({status: 'failed', outcome: 'failed', errorCode: 'model_key_invalid', error: 'User not found.'});
    expect((await (await req(`/v1/runs/${run.id}`)).json() as Run).errorCode).toBe('model_key_invalid');
    const finished = (await f.adapters.events.read('local-user', `run:${run.id}`, 0, 100)).map(e => e.payload.event as any).find(e => e.type === 'run.finished');
    expect(finished).toEqual({type: 'run.finished', outcome: 'failed', message: 'User not found.', code: 'model_key_invalid'});
    expect(chatCalls(f)).toHaveLength(1); // not retried
    expect(await (await req('/v1/model-key')).json()).toMatchObject({maskedKey: '••••AAAA', lastError: 'User not found.'});
    expect((await (await req('/v1/chats/' + snapshot!.run.chatId)).json()).activeRunId).toBeUndefined();
  });

  it('402 ends the run as model_credit_exhausted and leaves the key record alone', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    f.or.state.chat = () => Response.json({error: {code: 402, message: 'This request requires more credits.'}}, {status: 402});
    const {snapshot} = await f.turn(req, {});
    expect(snapshot?.run).toMatchObject({status: 'failed', errorCode: 'model_credit_exhausted', error: 'This request requires more credits.'});
    expect(chatCalls(f)).toHaveLength(1);
    expect((await (await req('/v1/model-key')).json()).lastError).toBeUndefined();
  });

  it('credit running out mid-stream is typed the same way', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    f.or.state.chat = () => sse([delta({content: 'Partial'}), JSON.stringify({error: {code: 402, message: 'Insufficient credits'}, choices: [{index: 0, delta: {content: ''}, finish_reason: 'error'}]})]);
    expect((await f.turn(req, {})).snapshot?.run).toMatchObject({status: 'failed', errorCode: 'model_credit_exhausted'});
  });

  it('a chosen model that left the catalogue falls back to the default, with a note on the run', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    const {snapshot, run} = await f.turn(req, {chatModelId: 'vendor/retired'});
    expect(snapshot?.run.status).toBe('completed');
    expect(snapshot?.run.note).toBe('vendor/retired is no longer available on OpenRouter. This turn used Default instead.');
    expect((await (await req(`/v1/runs/${run.id}`)).json()).note).toContain('vendor/retired');
    expect(chatCalls(f)[0]!.body.model).toBe(DEFAULT_MODEL_ID);
    // A listed model carries no note.
    expect((await f.turn(req, {})).snapshot?.run.note).toBeUndefined();
  });

  it('passes OpenRouter cost and token counts through to the run usage', async () => {
    const f = setup(), req = await f.client();
    await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
    f.or.state.chat = () => sse([delta({content: 'Hello'}), delta({}, 'stop'), usageChunk({prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.00081, prompt_tokens_details: {cached_tokens: 20}})]);
    const {snapshot, run} = await f.turn(req, {});
    expect(snapshot?.usage).toEqual({type: 'usage', inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 0, cost: 0.00081});
    const usage = (await f.adapters.events.read('local-user', `run:${run.id}`, 0, 100)).map(e => e.payload.event as any).find(e => e.type === 'usage');
    expect(usage.usage.cost).toBe(0.00081);
  });
});

describe('the key never leaves the server', () => {
  it('is absent from every response, event, synced row, checkpoint and log line of a full session', async () => {
    const logged: string[] = [];
    const spies = (['info', 'warn', 'error', 'log', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); }));
    try {
      const or = openRouter(), encryptionKey = randomBytes(32).toString('base64'), adapters = createLocalAdapters();
      const {app, service} = createPraxisApp({adapters, local: true, encryptionKey, fetcher: or.fetcher, modules: localModules('http://127.0.0.1:8787'), log: jsonLog});
      const seen: string[] = [];
      const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
        const response = await app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
        seen.push(JSON.stringify([...response.headers]) + await response.clone().text());
        return response;
      };
      await req('/v1/model-key', {method: 'paste', apiKey: KEY_A});
      await req('/v1/model-key');
      await req('/v1/model-key/check', {});
      await req('/v1/bootstrap');
      await req('/v1/models');
      await req('/v1/sync/pull?cursor=0');
      const chat = await (await req('/v1/chats', {type: 'chat.input', modelId: 'vendor/alpha'})).json();
      // OpenRouter echoes the key back in an error: it must still not reach the run, the record or a log.
      or.state.chat = () => Response.json({error: {code: 401, message: `Invalid key ${KEY_A}`, metadata: {raw: `Authorization: Bearer ${KEY_A}`}}}, {status: 401});
      const run = await (await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'Hi'})).json();
      await service.drain();
      await req(`/v1/runs/${run.id}`); await req(`/v1/runs/${run.id}/snapshot`); await req(`/v1/chats/${chat.id}/messages`); await req('/v1/model-key');
      await req(`/v1/runs/${run.id}/events?after=0`);
      await req('/v1/model-key', {method: 'pkce', code: 'good-code', codeVerifier: VERIFIER});
      await req('/v1/bootstrap');
      const userEvents = JSON.stringify(await adapters.events.read('local-user', 'user', 0, 1000));
      const runEvents = JSON.stringify(await adapters.events.read('local-user', `run:${run.id}`, 0, 1000));
      const rows: string[] = [];
      for (const kind of ['modelKey', 'run', 'snapshot', 'checkpoint', 'runRequest', 'message', 'chat', 'idempotency']) rows.push(JSON.stringify(await adapters.store.list('local-user', kind)));
      const everything = [...seen, userEvents, runEvents, ...rows, ...logged].join('\n');
      expect(seen.length).toBeGreaterThan(12);
      expect(userEvents).toContain('modelKey'); // the masked record is announced
      expect(runEvents).toContain('model_key_invalid');
      for (const secret of [KEY_A, PKCE_KEY, KEY_A.slice(9), PKCE_KEY.slice(9)]) expect(everything.includes(secret)).toBe(false);
      // Sealed blobs stay in the store row only.
      expect([...seen, userEvents, runEvents, ...logged].join('\n')).not.toContain('"sealed"');
      expect(rows[0]).toContain('"sealed":"v2.');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
