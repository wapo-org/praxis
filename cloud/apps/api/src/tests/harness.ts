import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {RunSnapshotSchema} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {createPraxisApp} from '../server.js';

/** Local app + fake OpenAI-compatible provider shared by the parity and review-fix suites. */
export function fakeOpenAI(turns: string[][]) {
  const requests: any[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input instanceof Request ? input.url : input).includes('llm.example.test')) return fetch(input, init);
    if (String(input).endsWith('/models')) return Response.json({data: [{id: 'm'}]});
    requests.push(JSON.parse(String(init?.body)));
    const frames = turns[requests.length - 1] ?? [delta({content: 'ok'}), delta({}, 'stop')];
    return new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }) as typeof fetch;
  return {fetcher, requests};
}
export const delta = (d: object, finish: string | null = null) => JSON.stringify({choices: [{index: 0, delta: d, finish_reason: finish}]});
export const toolCall = (name: string, args: object) => [delta({tool_calls: [{index: 0, id: `call_${name}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}), delta({}, 'tool_calls')];

export function setup(turns: string[][] = []) {
  const fake = fakeOpenAI(turns);
  const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher, modules: localModules('http://127.0.0.1:8787')});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const chat = async (capabilities: object = {vision: true, documents: true, tools: true}) => {
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    await req(`/v1/providers/${provider.id}/refresh-models`, {type: 'models.refresh'});
    return (await req('/v1/chats', {type: 'chat.input', providerId: provider.id, modelId: 'm'})).json();
  };
  const upload = async (chatId: string, name: string, mediaType: string, bytes: Uint8Array) => {
    const ticket = await (await req('/v1/uploads', {type: 'upload.request', name, mediaType, size: bytes.length, chatId})).json();
    const {storageId} = await (await app.request(new URL(ticket.uploadUrl).pathname, {method: 'PUT', headers: {Authorization: 'Bearer dev-local', 'Content-Type': mediaType}, body: new Blob([Uint8Array.from(bytes)])})).json();
    return (await (await req('/v1/uploads/complete', {type: 'upload.complete', storageId, name, mediaType, size: bytes.length, chatId})).json()).id as string;
  };
  const run = async (chatId: string, text: string, attachmentIds: string[] = []) => {
    const r = await (await req('/v1/runs', {type: 'run.start', chatId, text, attachmentIds})).json();
    await service.drain();
    return RunSnapshotSchema.parse(await (await req(`/v1/runs/${r.id}/snapshot`)).json());
  };
  return {req, chat, upload, run, fake, service};
}

export const png = (w: number, h: number) => sharp({create: {width: w, height: h, channels: 3, background: {r: 200, g: 10, b: 10}}}).png().toBuffer().then(b => new Uint8Array(b));
