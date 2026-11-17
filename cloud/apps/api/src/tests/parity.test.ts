import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {RunSnapshotSchema, type Message} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {createPraxisApp} from '../server.js';
import {TITLE_SYSTEM} from '../title-generation.js';
import {catalogEntry, connectKey, delta, fakeOpenRouter, png, setup, toolCall} from './harness.js';

describe('attachments reach the model (parity: AttachmentMedia)', () => {
  it('images are sent as bytes, PDFs as documents, text inline, other files named for fs; history keeps references', async () => {
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
    expect(content.filter((p: any) => p.type === 'file')).toHaveLength(1);
    expect(content).toContainEqual({type: 'text', text: '[File: “notes.txt”]\nhello notes'});
    expect(JSON.stringify(content)).toContain('[Attached file: “data.zip”. Read them with `fs` in run_javascript.]');
    const stored: Message[] = (await (await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(JSON.stringify(stored[0])).not.toContain(Buffer.from(image).toString('base64')); // bytes are never persisted in history
    // The zip is a structured note (model input), never text in the user's visible bubble (WP-J2).
    expect(stored[0]!.parts.filter(p => p.attachmentId).map(p => p.type)).toEqual(['image', 'document', 'document', 'note']);
    expect(stored[0]!.parts.filter(p => p.type === 'text').map(p => p.text)).toEqual(['Look']);
  });

  it('preserves a structured file note through prompt assembly while JavaScript fs reads its attachment bytes',async()=>{
    const f=setup([toolCall('run_javascript',{code:"return {names:await fs.list(),bytes:Array.from(await fs.readBytes('data.zip'))}"})]);
    const chat=await f.chat();const id=await f.upload(chat.id,'data.zip','application/zip',new Uint8Array([80,75,3,4]));
    const result=await f.run(chat.id,'Inspect this archive',[id]);expect(result.run.outcome).toBe('completed');expect(result.pendingApprovals).toHaveLength(0);
    const stored:Message[]=(await(await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(stored[0]!.parts).toContainEqual(expect.objectContaining({type:'note',attachmentId:id,text:expect.stringContaining('[Attached file: “data.zip”')}));
    expect(stored[0]!.parts.filter(p=>p.type==='text').map(p=>p.text)).toEqual(['Inspect this archive']);
    const first=JSON.stringify(f.fake.requests[0]);expect(first).toContain('[Attached file: “data.zip”');expect(first).toContain('Never ask permission or confirmation');
    const resumed=JSON.stringify(f.fake.requests[1].messages);expect(resumed).toContain('data.zip');expect(resumed).toContain('80,75,3,4');
  });

  it('gives run_javascript no network path; the web goes through web_search and web_read', async () => {
    const f = setup([toolCall('run_javascript', {code: "return typeof fetch"})]);
    const chat = await f.chat();
    expect((await f.run(chat.id, 'Check the network')).run.outcome).toBe('completed');
    expect(JSON.stringify(f.fake.requests[1].messages)).toContain('undefined');
    const tools: {function: {name: string; description: string}}[] = f.fake.requests[0].tools;
    expect(tools.find(t => t.function.name === 'run_javascript')?.function.description).not.toContain('fetch(');
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
    expect((await (await f.req(`/v1/chats/${a.id}`)).json()).title).toBe('Plan Trip Lisbon Very Long');
    await f.run(a.id, 'Second message');
    expect((await (await f.req(`/v1/chats/${a.id}`)).json()).title).toBe('Plan Trip Lisbon Very Long');

    const b = await f.chat();
    await f.run(b.id, '', [await f.upload(b.id, 'x.png', 'image/png', await png(2, 2))]);
    expect((await (await f.req(`/v1/chats/${b.id}`)).json()).title).toBe('Photo');
    await f.run(b.id, 'What is this?');
    expect((await (await f.req(`/v1/chats/${b.id}`)).json()).title).toBe('What');
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
    expect(tool.boundary).toEqual({capabilities: ['read'], decision: 'allow', untrustedSource: true});
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
    const fake = fakeOpenRouter([toolCall('mcp_call_tool', {tool: 'tool_7', arguments: {}}), [delta({content: 'done'}), delta({}, 'stop')]]);
    const service = new ApiService(createLocalAdapters(), true);
    service.driver = createExecutionDriver({service, fetcher: fake.fetcher, features: {tools: async (_ctx, {chat}) => withGateway(chat, tools())}});
    const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher});
    const req = async (path: string, body?: unknown) => app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    await service.adapters.store.put('local-user', 'connector', 'big', {type: 'connector', id: 'big', name: 'Big', url: 'https://big.example/mcp', transport: 'streamableHttp', enabled: true, trusted: true, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()});
    await connectKey(req);
    const newChat = async () => (await req('/v1/chats', {type: 'chat.input', modelId: 'm'})).json();
    const run = async (chatId: string) => { await req('/v1/runs', {type: 'run.start', chatId, text: 'go'}); await service.drain(); };

    const chat = await newChat();
    await run(chat.id);
    const offered = fake.requests[0].tools.map((t: any) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['mcp_search_tools', 'mcp_describe_tool', 'mcp_call_tool']));
    expect(offered.some((n: string) => n.startsWith('tool_'))).toBe(false);
    expect(calls).toEqual(['tool_7']);
    expect(JSON.stringify(fake.requests[1].messages)).toContain('result 7');

    count = 5; // Frozen gateway decision holds for existing chats; new chats get direct tools.
    await run(chat.id);
    expect(fake.requests[2].tools.map((t: any) => t.function.name)).toContain('mcp_call_tool');
    const fresh = await newChat();
    await run(fresh.id);
    expect(fake.requests.at(-1).tools.map((t: any) => t.function.name)).toContain('tool_0');
  });
});

describe('capabilities come from the catalogue, not from learning', () => {
  it('a refused tool request fails the run without stripping tools, and the next run offers tools again', async () => {
    const bodies: any[] = [];
    let rejections = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({data: [catalogEntry({id: 'm', tools: true})]});
      if (String(input).endsWith('/key')) return Response.json({data: {label: 'k', limit: null, limit_remaining: null}});
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.tools?.length) { rejections++; return Response.json({error: {message: 'No endpoints found that support tool use'}}, {status: 404}); }
      return new Response(`data: ${delta({content: 'ok'})}\n\ndata: ${delta({}, 'stop')}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}});
    }) as typeof fetch;
    const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher, modules: localModules('http://127.0.0.1:8787')});
    const req = async (path: string, body?: unknown) => app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    await connectKey(req);
    const chat = await (await req('/v1/chats', {type: 'chat.input', modelId: 'm'})).json();
    const run = async () => { const r = await (await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'hi'})).json(); await service.drain(); return RunSnapshotSchema.parse(await (await req(`/v1/runs/${r.id}/snapshot`)).json()); };

    expect((await run()).run.outcome).toBe('failed');
    expect(rejections).toBe(1);
    expect((await run()).run.outcome).toBe('failed');
    expect(rejections).toBe(2);
    expect(bodies.every(body => body.messages?.[0]?.content === TITLE_SYSTEM || body.tools?.length > 0)).toBe(true);
    expect(await service.adapters.store.list('local-user', 'modelLearning')).toEqual([]);
  });
});
