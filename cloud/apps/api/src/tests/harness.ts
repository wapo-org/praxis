import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {RunSnapshotSchema} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {createPraxisApp} from '../server.js';
import {TITLE_SYSTEM} from '../title-generation.js';

export const TEST_KEY = 'sk-or-v1-test-key-123456';
export interface FakeModel {id: string; name?: string; tools?: boolean; vision?: boolean; documents?: boolean; reasoning?: boolean; context?: number; maxOutput?: number; prompt?: string; completion?: string}
/** Fake OpenRouter model entry matching GET /models. */
export const catalogEntry = (m: FakeModel) => ({
  id: m.id, name: m.name ?? m.id, context_length: m.context ?? 128000,
  architecture: {input_modalities: ['text', ...(m.vision ? ['image'] : []), ...(m.documents ? ['file'] : [])], output_modalities: ['text']},
  pricing: {prompt: m.prompt ?? '0.000003', completion: m.completion ?? '0.000015'},
  top_provider: {context_length: m.context ?? 128000, max_completion_tokens: m.maxOutput ?? 16000},
  supported_parameters: ['max_tokens', ...(m.tools === false ? [] : ['tools', 'tool_choice']), ...(m.reasoning ? ['reasoning'] : [])],
});
/** Stubs OpenRouter endpoints; other hosts pass through to real fetch. */
export function fakeOpenRouter(turns: string[][], models: FakeModel[] = [{id: 'm', tools: true, vision: true, documents: true}]) {
  const titleRequests: Record<string, unknown>[] = [];
  const requests: any[] = [], authorizations: string[] = [];
  const state = {models, modelFetches: 0};
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://openrouter.ai/')) return fetch(input, init);
    if (url.endsWith('/api/v1/models')) { state.modelFetches++; return Response.json({data: state.models.map(catalogEntry)}); }
    if (url.endsWith('/api/v1/key')) return Response.json({data: {label: 'sk-or-v1-tes...456', limit: 10, limit_remaining: 7.5}});
    if (!url.endsWith('/api/v1/chat/completions')) return Response.json({error: {code: 404, message: 'Not found'}}, {status: 404});
    const body = JSON.parse(String(init?.body));
    const sse = (frames: string[]) => new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
    if (body.messages?.[0]?.content === TITLE_SYSTEM) {
      titleRequests.push(body);
      return sse([JSON.stringify({choices: [{index: 0, delta: {content: ''}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 3}})]);
    }
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    requests.push(JSON.parse(String(init?.body)));
    return sse(turns[requests.length - 1] ?? [delta({content: 'ok'}), delta({}, 'stop')]);
  }) as typeof fetch;
  return {fetcher, requests, titleRequests, authorizations, state};
}
/** Connects the test user's OpenRouter key by paste. */
export const connectKey = (req: (path: string, body?: unknown) => Promise<Response>, apiKey = TEST_KEY) => req('/v1/model-key', {method: 'paste', apiKey});
export const delta = (d: object, finish: string | null = null) => JSON.stringify({choices: [{index: 0, delta: d, finish_reason: finish}]});
export const toolCall = (name: string, args: object) => [delta({tool_calls: [{index: 0, id: `call_${name}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}), delta({}, 'tool_calls')];

export function setup(turns: string[][] = []) {
  const fake = fakeOpenRouter(turns);
  const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher, modules: localModules('http://127.0.0.1:8787')});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  /** Connects the test key and opens a chat on model `m`, whose catalogue entry has the given capabilities. */
  const chat = async (capabilities?: {vision?: boolean; documents?: boolean; tools?: boolean}) => {
    fake.state.models = [{id: 'm', vision: true, documents: true, tools: true, ...capabilities}];
    await connectKey(req);
    return (await req('/v1/chats', {type: 'chat.input', modelId: 'm'})).json();
  };
  const upload = async (chatId: string, name: string, mediaType: string, bytes: Uint8Array) => {
    const ticket = await (await req('/v1/uploads', {type: 'upload.request', name, mediaType, size: bytes.length, chatId})).json();
    const {storageId} = await (await app.request(new URL(ticket.uploadUrl).pathname, {method: 'PUT', headers: {Authorization: 'Bearer dev-local', 'Content-Type': mediaType}, body: new Blob([Uint8Array.from(bytes)])})).json();
    return (await (await req('/v1/uploads/complete', {type: 'upload.complete', storageId, name, mediaType, size: bytes.length, chatId})).json()).id as string;
  };
  const run = async (chatId: string, text: string, attachmentIds: string[] = []) => {
    const r = await (await req('/v1/runs', {type: 'run.start', chatId, text, attachmentIds})).json();
    await service.drain();
    let snapshot = RunSnapshotSchema.parse(await (await req(`/v1/runs/${r.id}/snapshot`)).json());
    for (const approval of snapshot.pendingApprovals.filter(item => item.toolName === 'run_javascript')) {
      await req(`/v1/runs/${r.id}/approvals`, {type: 'approval.decision', approvalId: approval.id, decision: 'allowOnce'});
      await service.drain();
      snapshot = RunSnapshotSchema.parse(await (await req(`/v1/runs/${r.id}/snapshot`)).json());
    }
    return snapshot;
  };
  return {req, chat, upload, run, fake, service};
}

export const png = (w: number, h: number) => sharp({create: {width: w, height: h, channels: 3, background: {r: 200, g: 10, b: 10}}}).png().toBuffer().then(b => new Uint8Array(b));
