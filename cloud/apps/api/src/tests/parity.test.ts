import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {RunSnapshotSchema, type Message} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {createPraxisApp} from '../server.js';

function fakeOpenAI(turns: string[][]) {
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
const delta = (d: object, finish: string | null = null) => JSON.stringify({choices: [{index: 0, delta: d, finish_reason: finish}]});
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

const png = (w: number, h: number) => sharp({create: {width: w, height: h, channels: 3, background: {r: 200, g: 10, b: 10}}}).png().toBuffer().then(b => new Uint8Array(b));

describe('attachments reach the model (parity: AttachmentMedia)', () => {
  it('images are sent as bytes, PDFs/text as documents, other files named for fs; history keeps references', async () => {
    const f = setup();
    const chat = await f.chat();
    const image = await png(8, 8);
    const ids = [
      await f.upload(chat.id, 'dot.png', 'image/png', image),
      await f.upload(chat.id, 'paper.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4 tiny')),
      await f.upload(chat.id, 'notes.txt', 'text/plain', new TextEncoder().encode('hello notes')),
      await f.upload(chat.id, 'data.zip', 'application/zip', new Uint8Array([80, 75, 3, 4])),
    ];
    expect((await f.run(chat.id, 'Look', ids)).run.status).toBe('completed');
    const content = f.fake.requests[0].messages.find((m: any) => m.role === 'user').content;
    const imagePart = content.find((p: any) => p.type === 'image_url');
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${Buffer.from(image).toString('base64')}`);
    expect(content.filter((p: any) => p.type === 'file')).toHaveLength(2);
    expect(JSON.stringify(content)).toContain('[Attached file: “data.zip”. Read them with `fs` in run_javascript.]');
    const stored: Message[] = (await (await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(JSON.stringify(stored[0])).not.toContain(Buffer.from(image).toString('base64')); // bytes are never persisted in history
    expect(stored[0]!.parts.filter(p => p.attachmentId).map(p => p.type)).toEqual(['image', 'document', 'document']);
  });

  it('re-encodes oversized images like the app (max 2000 px side) and sends nothing for a blind model', async () => {
    const f = setup();
    const chat = await f.chat();
    const id = await f.upload(chat.id, 'big.png', 'image/png', await png(3000, 1000));
    await f.run(chat.id, 'Big', [id]);
    const url: string = f.fake.requests[0].messages.find((m: any) => m.role === 'user').content.find((p: any) => p.type === 'image_url').image_url.url;
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const meta = await sharp(Buffer.from(url.split(',')[1]!, 'base64')).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2000);

    const blind = setup();
    const c2 = await blind.chat({vision: false, tools: true});
    const id2 = await blind.upload(c2.id, 'dot.png', 'image/png', await png(4, 4));
    await blind.run(c2.id, 'Hi', [id2]);
    expect(JSON.stringify(blind.fake.requests[0])).not.toContain('base64');
  });
});

describe('chat titles (parity: ConversationTitle)', () => {
  it('names the chat after its first message, or its attachments until words arrive', async () => {
    const f = setup();
    const a = await f.chat();
    await f.run(a.id, '   Plan   a trip\nto Lisbon with a very long description that goes on and on');
    expect((await (await f.req(`/v1/chats/${a.id}`)).json()).title).toBe('Plan a trip to Lisbon with a very long des');
    await f.run(a.id, 'Second message');
    expect((await (await f.req(`/v1/chats/${a.id}`)).json()).title).toBe('Plan a trip to Lisbon with a very long des');

    const b = await f.chat();
    await f.run(b.id, '', [await f.upload(b.id, 'x.png', 'image/png', await png(2, 2))]);
    expect((await (await f.req(`/v1/chats/${b.id}`)).json()).title).toBe('Photo');
    await f.run(b.id, 'What is this?');
    expect((await (await f.req(`/v1/chats/${b.id}`)).json()).title).toBe('What is this?');
  });
});

describe('read_tool_output (parity: ReadToolOutputTool)', () => {
  it('pages through a spilled result of this conversation only', async () => {
    const {readToolOutputTool} = await import('../execution.js');
    const big = 'x'.repeat(50_000) + 'THE-END';
    const f = setup([toolCall('run_javascript', {code: `return ${JSON.stringify(big)}`}), [delta({content: 'done'}), delta({}, 'stop')]]);
    const chat = await f.chat();
    const snap = await f.run(chat.id, 'Make a big output');
    expect(snap.run.status).toBe('completed');
    const note = JSON.stringify(f.fake.requests[1].messages);
    const id = /read_tool_output ([0-9a-f-]{36})/.exec(note)?.[1] ?? '';
    expect(id).toBeTruthy();
    const tool = readToolOutputTool(f.service);
    const ctx = (chatId: string) => ({userId: 'local-user', chatId, runId: snap.run.id, mode: 'build' as const, callId: 'c', signal: new AbortController().signal, callTool: async () => ({content: [], isError: false}), elicit: async () => ({type: 'elicitation.response' as const, elicitationId: 'e', action: 'cancel' as const}), emit: async () => {}});
    const tail = await tool.execute({id, offset: 50_000}, ctx(chat.id));
    expect(tail.isError).toBe(false);
    expect(JSON.stringify(tail.content)).toContain('THE-END');
    expect(JSON.stringify(tail.content)).toMatch(/characters 50000–\d+ of \d+/);
    expect((await tool.execute({id, offset: 0}, ctx('other-chat'))).isError).toBe(true);
  });
});

describe('MCP gateway above 30 connector tools (parity: MCPGateway / gatewayThreshold)', () => {
  it('offers the trio instead of direct tools, calls hidden tools through policy, and keeps the decision per chat', async () => {
    const {createExecutionDriver} = await import('../execution.js');
    const {ApiService} = await import('../service.js');
    const {createApp} = await import('../app.js');
    const {withGateway} = await import('../modules.js');
    let count = 31;
    const calls: string[] = [];
    const tools = () => Array.from({length: count}, (_, i) => ({
      name: `tool_${i}`, description: `Tool ${i}`, inputSchema: {type: 'object'}, source: {type: 'mcp' as const, serverId: 'big', serverName: 'Big'}, traits: ['readOnly' as const],
      execute: async () => { calls.push(`tool_${i}`); return `result ${i}`; },
    }));
    const fake = fakeOpenAI([toolCall('mcp_call_tool', {tool: 'tool_7', arguments: {}}), [delta({content: 'done'}), delta({}, 'stop')]]);
    const service = new ApiService(createLocalAdapters(), true);
    service.driver = createExecutionDriver({service, fetcher: fake.fetcher, features: {tools: async (_ctx, {chat}) => withGateway(chat, tools())}});
    const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher});
    const req = async (path: string, body?: unknown) => app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    await service.adapters.store.put('local-user', 'connector', 'big', {type: 'connector', id: 'big', name: 'Big', url: 'https://big.example/mcp', transport: 'streamableHttp', enabled: true, trusted: true, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()});
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities: {tools: true}})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    const newChat = async () => (await req('/v1/chats', {type: 'chat.input', providerId: provider.id, modelId: 'm'})).json();
    const run = async (chatId: string) => { await req('/v1/runs', {type: 'run.start', chatId, text: 'go'}); await service.drain(); };

    const chat = await newChat();
    await run(chat.id);
    const offered = fake.requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['mcp_search_tools', 'mcp_describe_tool', 'mcp_call_tool']));
    expect(offered.some((n: string) => n.startsWith('tool_'))).toBe(false);
    expect(calls).toEqual(['tool_7']);
    expect(JSON.stringify(fake.requests[1].messages)).toContain('result 7');

    count = 5; // fewer tools later: this chat keeps the gateway it started with; a new chat gets direct tools
    await run(chat.id);
    expect(fake.requests[2].tools.map((t: any) => t.function.name)).toContain('mcp_call_tool');
    const fresh = await newChat();
    await run(fresh.id);
    expect(fake.requests.at(-1).tools.map((t: any) => t.function.name)).toContain('tool_0');
  });
});

describe('learned provider rejections persist (parity: ProviderSettings toolRejections/imageRejections)', () => {
  it('a model that refused tools is sent without tools on the next turn until the model list is refreshed', async () => {
    const bodies: any[] = [];
    let rejections = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({data: [{id: 'm'}]});
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.tools?.length) { rejections++; return Response.json({error: {message: 'No endpoints found that support tool use'}}, {status: 404}); }
      return new Response(`data: ${delta({content: 'ok'})}\n\ndata: ${delta({}, 'stop')}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
    }) as typeof fetch;
    const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher, modules: localModules('http://127.0.0.1:8787')});
    const req = async (path: string, body?: unknown) => app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities: {tools: true}})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    await req(`/v1/providers/${provider.id}/refresh-models`, {type: 'models.refresh'});
    const chat = await (await req('/v1/chats', {type: 'chat.input', providerId: provider.id, modelId: 'm'})).json();
    const run = async () => { const r = await (await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'hi'})).json(); await service.drain(); return RunSnapshotSchema.parse(await (await req(`/v1/runs/${r.id}/snapshot`)).json()); };

    expect((await run()).run.outcome).toBe('completed');
    expect(rejections).toBe(1); // learned during the first turn (retried without tools)
    expect((await run()).run.outcome).toBe('completed');
    expect(rejections).toBe(1); // next turn already goes without tools
    await req(`/v1/providers/${provider.id}/refresh-models`, {type: 'models.refresh'});
    await run();
    expect(rejections).toBe(2); // a fresh model list clears what was learned
  });
});
