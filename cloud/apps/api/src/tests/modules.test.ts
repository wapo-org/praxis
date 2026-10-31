import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {RunSnapshotSchema} from '@praxis/protocol';
import {createLocalAdapters} from '../local-memory.js';
import {localModules} from '../modules.js';
import {createPraxisApp} from '../server.js';

/** Fake OpenAI-compatible endpoint: one SSE body per chat.completions request; records request bodies. */
function fakeOpenAI(turns: string[][]) {
  const requests: any[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Only the fake model host is faked; anything else (e.g. MCP probes) goes to the real network stack.
    if (!String(input instanceof Request ? input.url : input).includes('llm.example.test')) return fetch(input, init);
    if (String(input).endsWith('/models')) return Response.json({data: [{id: 'blind-model'}]});
    requests.push(JSON.parse(String(init?.body)));
    const frames = turns[requests.length - 1] ?? [];
    return new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }) as typeof fetch;
  return {fetcher, requests};
}
const delta = (d: object, finish: string | null = null) => JSON.stringify({choices: [{index: 0, delta: d, finish_reason: finish}]});
const toolCall = (name: string, args: object) => [delta({tool_calls: [{index: 0, id: `call_${name}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]}), delta({}, 'tool_calls')];
const done = [delta({content: 'Done'}), delta({}, 'stop')];

function setup(fetcher: typeof fetch = fakeOpenAI([]).fetcher) {
  const {app, service} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), fetcher, modules: localModules('http://127.0.0.1:8787')});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET', auth = true) =>
    app.request(path, {method, headers: {...(auth ? {Authorization: 'Bearer dev-local'} : {}), 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {app, service, req};
}
const skillDoc = '---\nname: haiku-writer\ndescription: Writes haiku on request\n---\nAlways answer in 5-7-5 syllables.\n';

async function realChat(f: ReturnType<typeof setup>, capabilities: object = {}) {
  const provider = await (await f.req('/v1/providers', {type: 'provider.input', name: 'Fake', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities})).json();
  await f.req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
  await f.req(`/v1/providers/${provider.id}/refresh-models`, {type: 'models.refresh'});
  const chat = await (await f.req('/v1/chats', {type: 'chat.input', title: 'Tools', providerId: provider.id, modelId: 'blind-model'})).json();
  return {provider, chat};
}
async function runToEnd(f: ReturnType<typeof setup>, chatId: string, text: string, attachmentIds: string[] = []) {
  const run = await (await f.req('/v1/runs', {type: 'run.start', chatId, text, attachmentIds})).json();
  if (!run.id) throw new Error(JSON.stringify(run));
  await f.service.drain();
  return RunSnapshotSchema.parse(await (await f.req(`/v1/runs/${run.id}/snapshot`)).json());
}

describe('feature modules mounted under /v1', () => {
  it('serves tools and MCP routes behind auth, and the OAuth metadata publicly', async () => {
    const f = setup();
    expect((await f.req('/v1/skills', undefined, 'GET', false)).status).toBe(401);
    expect((await f.req('/v1/skills')).status).toBe(200);
    expect((await f.req('/v1/connectors')).status).toBe(200);
    expect((await f.req('/v1/skill-registries')).status).toBe(200);
    const created = await f.req('/v1/skills', {type: 'skill.input', name: 'haiku-writer', description: 'Writes haiku on request', document: skillDoc});
    expect(created.status).toBeLessThan(300);
    expect((await f.req('/v1/oauth/client-metadata.json', undefined, 'GET', false)).status).toBe(200);
  });

  it('freezes builtin tools + skill catalog and runs load_skill and run_javascript through the loop', async () => {
    const fake = fakeOpenAI([toolCall('load_skill', {name: 'haiku-writer'}), toolCall('run_javascript', {code: 'return 6 * 7'}), done]);
    const f = setup(fake.fetcher);
    await f.req('/v1/skills', {type: 'skill.input', name: 'haiku-writer', description: 'Writes haiku on request', document: skillDoc});
    const {chat} = await realChat(f, {vision: true});
    const snapshot = await runToEnd(f, chat.id, 'Write a haiku');
    expect(snapshot.run.status).toBe('completed');
    const names = fake.requests[0].tools.map((t: any) => t.function.name);
    expect(names).toEqual(expect.arrayContaining(['load_skill', 'read_skill_file', 'run_javascript']));
    expect(names).not.toContain('look_at_image');
    expect(fake.requests[0].messages[0].content).toContain('- haiku-writer: Writes haiku on request');
    expect(JSON.stringify(fake.requests[1].messages)).toContain('Always answer in 5-7-5 syllables.');
    expect(JSON.stringify(fake.requests[2].messages)).toContain('\\"result\\":42');
  });

  it('offers look_at_image from the vision preference when the chat model is blind, and reads an uploaded image', async () => {
    const turns: string[][] = [];
    const fake = fakeOpenAI(turns);
    const f = setup(fake.fetcher);
    const {chat} = await realChat(f, {vision: false});
    const png = randomBytes(64);
    const ticket = await (await f.req('/v1/uploads', {type: 'upload.request', name: 'shot.png', mediaType: 'image/png', size: png.length, chatId: chat.id})).json();
    const put = await f.app.request(new URL(ticket.uploadUrl).pathname, {method: ticket.method ?? 'PUT', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'image/png'}, body: png});
    const {storageId} = await put.json();
    const attachment = await (await f.req('/v1/uploads/complete', {type: 'upload.complete', storageId, name: 'shot.png', mediaType: 'image/png', size: png.length, chatId: chat.id})).json();
    expect(attachment.id).toBeTruthy();
    // Local seed sets the vision preference to the scripted reader.
    turns.push(toolCall('look_at_image', {image_id: attachment.id, question: 'What is shown?'}), done);
    const snapshot = await runToEnd(f, chat.id, 'Describe it', [attachment.id]);
    expect(snapshot.run.status).toBe('completed');
    expect(fake.requests[0].tools.map((t: any) => t.function.name)).toContain('look_at_image');
    expect(JSON.stringify(fake.requests[1].messages)).toContain('Scripted image reader received a image/png and the question: What is shown?');
  });

  it('does not offer look_at_image when the chat model sees images', async () => {
    const fake = fakeOpenAI([done]);
    const f = setup(fake.fetcher);
    const {chat} = await realChat(f, {vision: true});
    await runToEnd(f, chat.id, 'Hi');
    expect(fake.requests[0].tools.map((t: any) => t.function.name)).not.toContain('look_at_image');
  });
});

describe('connector health in runs', () => {
  it('an unreachable connector is created with its status, offers no tools, and the turn says why', async () => {
    const fake = fakeOpenAI([done]);
    const f = setup(fake.fetcher);
    const created = await f.req('/v1/connectors', {type: 'connector.input', name: 'Ghost', url: 'https://mcp.does-not-exist.invalid/mcp'});
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({status: 'unreachable'});
    const {chat} = await realChat(f, {vision: true});
    expect((await runToEnd(f, chat.id, 'Hi')).run.status).toBe('completed');
    expect(fake.requests[0].tools.map((t: any) => t.function.name).some((n: string) => n.startsWith('mcp__'))).toBe(false);
    const messages = (await (await f.req(`/v1/chats/${chat.id}/messages`)).json()).items;
    expect(messages[0].parts).toContainEqual({type: 'note', text: "The Ghost connector can't be reached right now, so its tools aren't available in this turn."});
  });
});
