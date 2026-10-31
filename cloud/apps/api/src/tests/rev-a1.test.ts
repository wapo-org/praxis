import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {CheckpointSchema} from '@praxis/agent';
import {RunSnapshotSchema} from '@praxis/protocol';
import {createApp} from '../app.js';
import type {FeatureTool} from '../contracts.js';
import {createExecutionDriver, memoryLease, type RunLease, type ContinuationScheduler, type ExecutionFeatures} from '../execution.js';
import {createLocalAdapters} from '../local-memory.js';
import {ApiService} from '../service.js';

function fakeOpenAI(turns: string[][]) {
  const requests: any[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/models')) return Response.json({data: [{id: 'm'}]});
    requests.push(JSON.parse(String(init?.body)));
    const frames = turns[requests.length - 1] ?? [];
    return new Response(frames.map(f => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
  }) as typeof fetch;
  return {fetcher, requests};
}
const delta = (d: object, finish: string | null = null) => JSON.stringify({choices: [{index: 0, delta: d, finish_reason: finish}]});
const toolCall = (name: string) => [delta({tool_calls: [{index: 0, id: `call_${name}`, type: 'function', function: {name, arguments: '{}'}}]}), delta({}, 'tool_calls')];
const done = [delta({content: 'Done'}), delta({}, 'stop')];
const tool = (name: string, traits: FeatureTool['traits'], execute: FeatureTool['execute'], source: FeatureTool['source'] = {type: 'builtin'}): FeatureTool =>
  ({name, description: name, inputSchema: {type: 'object'}, source, traits, execute});

function setup(turns: string[][], features: ExecutionFeatures, extra: {scheduler?: ContinuationScheduler; budgetMs?: number; clock?: () => number; lease?: RunLease} = {}) {
  const fake = fakeOpenAI(turns);
  const service = new ApiService(createLocalAdapters(), true);
  const driver = createExecutionDriver({service, fetcher: fake.fetcher, features, ...extra});
  service.driver = driver;
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher});
  const req = async (path: string, body?: unknown, method = body ? 'POST' : 'GET') =>
    app.request(path, {method, headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const chat = async (mode = 'build') => {
    const provider = await (await req('/v1/providers', {type: 'provider.input', name: 'F', flavor: 'openAIChat', baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-test-123456', capabilities: {tools: true}})).json();
    await req('/v1/consents', {type: 'consent', host: 'llm.example.test', allowed: true});
    return (await req('/v1/chats', {type: 'chat.input', title: 'T', mode, providerId: provider.id, modelId: 'm'})).json();
  };
  const snapshot = async (runId: string) => RunSnapshotSchema.parse(await (await req(`/v1/runs/${runId}/snapshot`)).json());
  return {service, driver, req, chat, snapshot, fake};
}

describe('REV-A1 P0 execution.ts:195 — one executor per run', () => {
  it('two concurrent continuations of one checkpoint execute its tool once', async () => {
    let executions = 0;
    const scheduled: string[] = [];
    let now = 0;
    const f = setup([toolCall('side_effect'), done], {tools: async () => [tool('side_effect', ['sandboxed'], async () => { executions++; await new Promise(r => setTimeout(r, 5)); return 'ok'; })]},
      {scheduler: {schedule: async (_u, runId) => { scheduled.push(runId); }}, budgetMs: 500, clock: () => (now += 1000)});
    const chat = await f.chat();
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'})).json();
    await f.service.drain();
    expect((await f.snapshot(run.id)).run.status).toBe('continuing');
    expect(scheduled).toEqual([run.id]);
    await Promise.all([f.driver.continue('local-user', run.id), f.driver.continue('local-user', run.id)]);
    expect(executions).toBe(1);
    const events = await f.service.adapters.events.read('local-user', `run:${run.id}`, 0, 500);
    expect(events.filter(e => (e.payload.event as {type: string}).type === 'tool.finished')).toHaveLength(1);
  });

  it('a stale executor whose checkpoint revision moved on cannot write (fenced)', async () => {
    const f = setup([done], {});
    const chat = await f.chat();
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'})).json();
    await f.service.drain();
    const row = (await f.service.adapters.store.get('local-user', 'checkpoint', run.id))!;
    expect(await f.service.adapters.store.putIfRevision('local-user', 'checkpoint', run.id, row.value, row.revision - 1)).toBeNull();
    expect(await f.service.adapters.store.putIfRevision('local-user', 'checkpoint', run.id, row.value, row.revision)).not.toBeNull();
  });
});

describe('REV-A1 P1 execution.ts:260 — nested approval through an adapted tool', () => {
  it('parks for the nested approval and runs the nested tool once after allowOnce', async () => {
    let writes = 0;
    const writer = tool('writer', ['destructive'], async () => { writes++; return 'written'; }, {type: 'mcp', serverId: 'untrusted', serverName: 'Remote'});
    const outer = tool('outer', ['readOnly'], async (_args, ctx) => ctx.callTool!('writer', {}));
    const f = setup([toolCall('outer'), done], {tools: async () => [outer, writer]});
    const chat = await f.chat('build');
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'})).json();
    await f.service.drain();
    const parked = await f.snapshot(run.id);
    expect(parked.run.status).toBe('awaitingApproval');
    expect(parked.pendingApprovals[0]).toMatchObject({toolName: 'writer'});
    expect(parked.pendingApprovals[0]!.parentCallId).toBeTruthy();
    await f.req(`/v1/runs/${run.id}/approvals`, {type: 'approval.decision', approvalId: parked.pendingApprovals[0]!.id, decision: 'allowOnce'});
    await f.service.drain();
    expect((await f.snapshot(run.id)).run.outcome).toBe('completed');
    expect(writes).toBe(1);
    expect(JSON.stringify(f.fake.requests[1].messages)).toContain('written');
  });
});

describe('REV-A1 P1 policy.ts:20 — trusted read-only MCP tools in plan mode', () => {
  it('allows a trusted connector read-only tool in plan mode and refuses it once trust is revoked', async () => {
    let reads = 0;
    const mcpRead = tool('docs_search', ['readOnly'], async () => { reads++; return 'found'; }, {type: 'mcp', serverId: 'conn-1', serverName: 'Docs'});
    const f = setup([toolCall('docs_search'), done, toolCall('docs_search'), done], {tools: async () => [mcpRead]});
    const connector = {type: 'connector', id: 'conn-1', name: 'Docs', url: 'https://docs.example.test/mcp', transport: 'streamableHttp', enabled: true, trusted: true, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()};
    await f.service.adapters.store.put('local-user', 'connector', 'conn-1', connector);
    const chat = await f.chat('plan');
    const first = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'search'})).json();
    await f.service.drain();
    expect((await f.snapshot(first.id)).run.outcome).toBe('completed');
    expect(reads).toBe(1);

    await f.service.adapters.store.put('local-user', 'connector', 'conn-1', {...connector, trusted: false});
    const second = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'again'})).json();
    await f.service.drain();
    expect(reads).toBe(1);
    expect(JSON.stringify((await f.snapshot(second.id)).tools)).toContain('Plan mode only runs read-only tools.');
  });
});

describe('REV-A2 API outbox recovery', () => {
  it.each([{status: 'completed', delivered: true}, {status: 'running', delivered: true}, {status: 'completed', delivered: false}, {status: 'running', delivered: false}] as const)('flushes $status outbox (previously delivered=$delivered) with exactly one SSE event', async ({status, delivered}) => {
    const f = setup([done], {});
    const chat = await f.chat();
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'})).json();
    await f.service.drain();
    const row = (await f.service.adapters.store.get('local-user', 'checkpoint', run.id))!;
    const cp = CheckpointSchema.parse(row.value);
    const message = structuredClone(cp.messages.at(-1)!);
    if (!delivered) { message.id = crypto.randomUUID(); cp.messages[cp.messages.length - 1] = message; }
    // Crash after append succeeded but before the checkpoint acknowledged delivery.
    cp.outbox = [message]; cp.run.status = status;
    if (status === 'running') { cp.phase = 'model'; cp.maxIterations = cp.iteration; }
    await f.service.adapters.store.put('local-user', 'checkpoint', run.id, JSON.parse(JSON.stringify(cp)));
    const before = await f.service.adapters.events.read('local-user', `run:${run.id}`, 0, 1000);
    const original = before.find(e => (e.payload.event as any).type === 'messages.committed' && (e.payload.event as any).messages.some((m: any) => m.id === message.id))!;
    if (status === 'completed') await f.service.adapters.store.delete('local-user', 'provider', chat.providerId);
    await f.driver.continue('local-user', run.id);
    await f.driver.continue('local-user', run.id);
    const recovered = CheckpointSchema.parse((await f.service.adapters.store.get('local-user', 'checkpoint', run.id))!.value);
    expect(recovered.outbox).toEqual([]);
    const events = await f.service.adapters.events.read('local-user', `run:${run.id}`, 0, 1000);
    const deliveries = events.filter(e => (e.payload.event as any).type === 'messages.committed' && (e.payload.event as any).messages.some((m: any) => m.id === message.id));
    expect(deliveries).toHaveLength(1);
    if (delivered) expect(deliveries[0]!.id).toBe(original.id);
    expect((await f.snapshot(run.id)).lastEventId).toBeGreaterThanOrEqual(before.at(-1)!.id);
  });
});

it('expiry during running side effect: a second continuation never repeats it',async()=>{
 let n=0,now=0,leaseNow=0,release!:()=>void,entered!:()=>void;
 const enteredP=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 const f=setup([toolCall('slow'),done],{tools:async()=>[tool('slow',['sandboxed'],async()=>{n++;entered();await blocked;return 'ok';})]},
 {scheduler:{schedule:async()=>{}},budgetMs:500,clock:()=>now+=1000,lease:memoryLease(()=>leaseNow)});
 const chat=await f.chat(),run=await(await f.req('/v1/runs',{type:'run.start',chatId:chat.id,text:'go'})).json();await f.service.drain();
 const first=f.driver.continue('local-user',run.id);await enteredP;
 leaseNow=1_000_000;await f.driver.continue('local-user',run.id);release();await first;
 expect(n).toBe(1);
});


it('nested cancel is propagated',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const outer=tool('outer',['readOnly'],async(_a,c)=>c.callTool!('inner',{}));
 const inner=tool('inner',['readOnly'],async(_a,c)=>{entered();await new Promise<void>(r=>c.signal!.addEventListener('abort',()=>r(),{once:true}));return 'x';});
 const f=setup([toolCall('outer'),done],{tools:async()=>[outer,inner]});const chat=await f.chat();
 const run=await(await f.req('/v1/runs',{type:'run.start',chatId:chat.id,text:'go'})).json();await started;
 await f.service.adapters.kv.set(`cancel:local-user:${run.id}`,true,60);await f.service.drain();
 expect((await f.snapshot(run.id)).run.outcome).toBe('cancelled');
});


it('trust revoked within the same run is recomputed on its next slice',async()=>{
 let reads=0,now=0;const f=setup([toolCall('read'),done],{tools:async()=>[tool('read',['readOnly'],async()=>{reads++;return 'x';},{type:'mcp',serverId:'conn',serverName:'S'})]}, {budgetMs:500,clock:()=>now+=1000,scheduler:{schedule:async()=>{}}});
 const c:any={type:'connector',id:'conn',name:'S',url:'https://example.test/mcp',transport:'streamableHttp',enabled:true,trusted:true,disabledTools:[],authStatus:'none',updatedAt:'2026-10-29T12:00:00.000Z'};await f.service.adapters.store.put('local-user','connector','conn',c);
 const chat=await f.chat('plan'),run=await(await f.req('/v1/runs',{type:'run.start',chatId:chat.id,text:'go'})).json();await f.service.drain();
 await f.service.adapters.store.put('local-user','connector','conn',{...c,trusted:false});await f.driver.continue('local-user',run.id);
 expect(reads).toBe(0);expect(JSON.stringify((await f.service.adapters.store.get('local-user','checkpoint',run.id))!.value)).toContain('Plan mode only runs read-only tools');
});
