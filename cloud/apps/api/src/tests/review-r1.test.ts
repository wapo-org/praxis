import {describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {MAX_RESULT_CHARACTERS, type AgentCheckpoint, type ModelProvider, type ProviderRequest} from '@praxis/agent';
import {CapabilitiesSchema, type MessagePart} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {ApiService} from '../service.js';
import {LEARNED_LIFETIME_MS, learnedFor, recordLearning} from '../learning.js';
import {MEDIA_CONCURRENCY, withMedia} from '../media-provider.js';
import {MAX_READ_CHARACTERS, readToolOutputTool} from '../read-tool-output.js';
import {MAX_INPUT_PIXELS, rehydrateAttachment} from '../features/tools/media.js';
import type {ToolsStorage} from '../features/tools/ports.js';
import type {FeatureContext} from '../contracts.js';
import {createPraxisApp} from '../server.js';
import {localModules} from '../modules.js';
import {png, setup} from './harness.js';

const caps = CapabilitiesSchema.parse({vision: true, documents: true, tools: true});
const request = (parts: MessagePart[]) => ({model: 'm', system: '', messages: [{type: 'message', id: 'm', chatId: 'c', role: 'user', parts, createdAt: '', updatedAt: ''}], tools: [], capabilities: caps, webSearch: false}) as unknown as ProviderRequest;
const userText = (f: ReturnType<typeof setup>, i: number) => JSON.stringify(f.fake.requests[i].messages.filter((m: any) => m.role === 'user'));

describe('REV-R1 P1 1: learned rejections lapse and are learned again', () => {
  it('re-records an expired image/tool/effort rejection instead of keeping the stale timestamp', async () => {
    const service = new ApiService(createLocalAdapters(), true);
    await service.adapters.store.put('u', 'model', 'p:m', {type: 'model', id: 'm', providerId: 'p', displayName: 'M', capabilities: caps, reasoningEfforts: ['low', 'high'], pinned: false, favorite: false});
    const now = 10 * LEARNED_LIFETIME_MS, stale = now - LEARNED_LIFETIME_MS - 1;
    await service.adapters.store.put('u', 'modelLearning', 'p:m', {images: stale, tools: stale, efforts: {levels: ['low'], at: stale}});
    expect(await learnedFor(service, 'u', 'p', 'm', now)).toEqual({images: false, tools: false, efforts: undefined});
    const cp = {chat: {providerId: 'p'}, modelId: 'm', capabilities: {...caps, vision: false, tools: false}, supportedEfforts: ['low']} as unknown as AgentCheckpoint;
    await recordLearning(service, 'u', cp, now);
    expect((await service.adapters.store.get('u', 'modelLearning', 'p:m'))?.value).toEqual({images: now, tools: now, efforts: {levels: ['low'], at: now}});
    expect(await learnedFor(service, 'u', 'p', 'm', now + 1)).toEqual({images: true, tools: true, efforts: ['low']});
  });
});

describe('REV-R1 P1 2/3: attachments never break a conversation', () => {
  it('a PDF for a model without documents gets a clear note; a broken image becomes a note and later turns still work', async () => {
    const f = setup();
    const chat = await f.chat({vision: true, documents: false, tools: true});
    const pdf = await f.upload(chat.id, 'paper.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4 tiny'));
    const bad = await f.upload(chat.id, 'bad.png', 'image/png', new TextEncoder().encode('not an image at all'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await f.run(chat.id, 'Look', [pdf, bad])).run.status).toBe('completed');
    expect(userText(f, 0)).toContain('[Attached PDF “paper.pdf”: this model can\'t read documents. Read it with `fs` in run_javascript.]');
    expect(userText(f, 0)).toContain('[Attachment unavailable: ');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"event":"attachment_unavailable"'));
    expect((await f.run(chat.id, 'And now?')).run.status).toBe('completed');
    expect(userText(f, 1)).toContain('[Attachment unavailable: ');
    warn.mockRestore();
  });

  it('a deleted attachment or failing storage read degrades to a note instead of failing the request', async () => {
    const seen: ProviderRequest[] = [];
    const base: ModelProvider = {flavor: 'openAIChat', capabilities: caps, async *stream(req) { seen.push(req); }};
    const provider = withMedia(base, async () => { throw new Error('File not found'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parts: MessagePart[] = [{type: 'image', attachmentId: 'a'}];
    for await (const _ of provider.stream(request(parts), new AbortController().signal)) void _;
    expect(seen[0]!.messages[0]!.parts).toEqual([{type: 'text', text: '[Attachment unavailable: File not found]'}]);
    warn.mockRestore();
  });
});

describe('REV-R1 P1 4: image memory', () => {
  it('caps decoding at about 40 MP', async () => {
    expect(MAX_INPUT_PIXELS).toBeLessThanOrEqual(40_000_000);
    const huge = new Uint8Array(await sharp({create: {width: 7000, height: 6000, channels: 3, background: '#fff'}}).png({compressionLevel: 1}).toBuffer());
    const storage = {read: async () => ({bytes: huge, mediaType: 'image/png'})} as unknown as ToolsStorage;
    const ctx = {...createLocalAdapters(), userId: 'u', local: true, fetch, egress: fetch} as FeatureContext;
    await ctx.store.put('u', 'attachment', 'a', {name: 'huge.png', storageId: 's'});
    await expect(rehydrateAttachment(ctx, storage, {type: 'image', attachmentId: 'a', mediaType: 'image/png'}, caps)).rejects.toThrow(/pixel limit/i);
  });

  it('resolves attachments with bounded concurrency', async () => {
    let active = 0, peak = 0;
    const provider = withMedia({flavor: 'openAIChat', capabilities: caps, async *stream() {}}, async part => {
      active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return {...part, data: 'x'};
    });
    const parts: MessagePart[] = Array.from({length: 8}, (_, i) => ({type: 'image', attachmentId: `a${i}`}));
    for await (const _ of provider.stream(request(parts), new AbortController().signal)) void _;
    expect(peak).toBeLessThanOrEqual(MEDIA_CONCURRENCY);
  });

  it('re-encodes an oversized image once and serves later slices from the cache', async () => {
    const big = await png(3000, 1000);
    const read = vi.fn(async () => ({bytes: big, mediaType: 'image/png'}));
    const storage = {read} as unknown as ToolsStorage;
    const ctx = {...createLocalAdapters(), userId: 'u', local: true, fetch, egress: fetch} as FeatureContext;
    await ctx.store.put('u', 'attachment', 'a', {name: 'big.png', storageId: 's'});
    const part: MessagePart = {type: 'image', attachmentId: 'a', mediaType: 'image/png'};
    const first = await rehydrateAttachment(ctx, storage, part, caps);
    const second = await rehydrateAttachment(ctx, storage, part, caps);
    expect(first.mediaType).toBe('image/jpeg');
    expect(second).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('REV-R1 P2: read_tool_output stays under the spill threshold', () => {
  it('caps a requested page so the result is never truncated again', async () => {
    const service = new ApiService(createLocalAdapters(), true);
    await service.adapters.store.put('u', 'output', 'o', {type: 'tool.output', id: 'o', runId: 'r', chatId: 'c', callId: 'k', text: 'x'.repeat(100_000)});
    const result = await readToolOutputTool(service).execute({id: 'o', offset: 0, limit: 40_000}, {userId: 'u', chatId: 'c'} as never);
    const text = String(result.content[0]!.text);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARACTERS);
    expect(text).toContain(`characters 0–${MAX_READ_CHARACTERS} of 100000`);
  });
});

describe('REV-R1 P2: provider probe failures and budget', () => {
  it('returns ok:false with a typed, redacted error, and limits probes per provider', async () => {
    const key = 'sk-live-SECRET-123456';
    const fetcher = (async (input: RequestInfo | URL) => String(input).endsWith('/models')
      ? Response.json({data: [{id: 'm'}]})
      : Response.json({error: {message: `Invalid API key ${key}`}}, {status: 401})) as typeof fetch;
    const {app} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher, modules: localModules('http://127.0.0.1:8787')});
    const req = async (path: string, body: unknown) => app.request(path, {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: key, capabilities: {tools: true}})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    await req(`/v1/providers/${provider.id}/refresh-models`, {type: 'models.refresh'});
    const probe = () => req(`/v1/providers/${provider.id}/test`, {type: 'provider.test', modelId: 'm'});
    const first = await probe();
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({type: 'provider.test.result', ok: false, error: {code: 'provider_error'}});
    expect(JSON.stringify(body)).not.toContain(key);
    expect(body.error.message).toContain('[redacted]');
    await probe(); await probe();
    expect((await probe()).status).toBe(429);
  });
});

describe('WP-W3: bootstrap names the user-event cursor', () => {
  it('eventCursor is the newest user event, so a client can follow other clients from now', async () => {
    const f = setup();
    const chat = await f.chat();
    const boot = await (await f.req('/v1/bootstrap')).json();
    expect(boot.eventCursor).toBe(await f.service.adapters.events.latest!('local-user', 'user'));
    expect(boot.eventCursor).toBeGreaterThan(0);
    await f.run(chat.id, 'hi');
    const later = (await f.service.adapters.events.read('local-user', 'user', boot.eventCursor)).map(e => e.payload.entity);
    expect(later).toContain('chat'); // the run start's chat upsert (activeRunId) is after the cursor
  });
});
