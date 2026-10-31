import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Hono} from 'hono';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import type {Chat, Connector} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {fixtures} from '../../tests/fixture.js';
import {createMcpRoutes, getMcpTools} from './index.js';
import {connectorTurnNotes, probeConnector, recordFailure, RECHECK_MS} from './health.js';
import {connector, McpError, saveConnector, writeSecret} from './shared.js';
import {fixtureServer} from './fixture.js';

let remote: Awaited<ReturnType<typeof fixtureServer>>;
let protectedRemote: Awaited<ReturnType<typeof fixtureServer>>;
let hanging: Server, broken: Server;
let hangingUrl = '', brokenUrl = '';
beforeAll(async () => {
  remote = await fixtureServer();
  protectedRemote = await fixtureServer();
  protectedRemote.protect();
  hanging = createServer(() => { /* never answers */ });
  broken = createServer((_req, res) => { res.writeHead(500, {'content-type': 'text/plain'}); res.end('boom'); });
  for (const s of [hanging, broken]) await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  hangingUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/mcp`;
  brokenUrl = `http://127.0.0.1:${(broken.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => {
  await remote.close(); await protectedRemote.close();
  hanging.closeAllConnections(); broken.closeAllConnections();
  await Promise.all([hanging, broken].map(s => new Promise<void>(r => s.close(() => r()))));
});

function setup() {
  let calls = 0;
  const counting: typeof fetch = (input, init) => { calls++; return fetch(input, init); };
  const ctx: FeatureContext = {...fixtures(), userId: 'alice', fetch: counting, egress: counting, local: true, encryptionKey: randomBytes(32).toString('base64')};
  const app = new Hono().route('/v1', createMcpRoutes(async () => ctx, {publicOrigin: 'http://127.0.0.1:8788'}));
  const request = (path: string, data?: unknown, method = data ? 'POST' : 'GET') => app.request(`/v1${path}`, {method, headers: {'Content-Type': 'application/json'}, ...(data ? {body: JSON.stringify(data)} : {})});
  const add = async (url: string, input = {}) => {
    const res = await request('/connectors', {type: 'connector.input', name: 'Docs', url, ...input});
    expect(res.status).toBe(201);
    return (await res.json()) as Connector;
  };
  const chat: Chat = {type: 'chat', id: 'chat-1', title: 'c', pinned: false, mode: 'build', connectorIds: [], disabledConnectorIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
  return {ctx, request, add, chat, calls: () => calls};
}

describe('connector health on create (REV-B13 P1)', () => {
  it('a server that does not exist is created but reported unreachable, never connected', async () => {
    const s = setup();
    const value = await s.add('https://mcp.does-not-exist.invalid/mcp');
    expect(value).toMatchObject({status: 'unreachable', statusCode: 'mcp_unreachable'});
    expect(value.lastCheckedAt).toBeTruthy();
    expect(value.toolCount).toBeUndefined();
  });
  it('a working server completes the handshake: connected with its tool count', async () => {
    const s = setup();
    const value = await s.add(`${remote.base}/mcp`);
    expect(value).toMatchObject({status: 'connected'});
    expect(value.toolCount).toBeGreaterThan(0);
    expect(value.statusCode).toBeUndefined();
  });
  it('a server requiring sign-in is needs_auth; with saved credentials that stop working it is needs_reauth', async () => {
    const s = setup();
    const value = await s.add(`${protectedRemote.base}/mcp`);
    expect(value.status).toBe('needs_auth');
    await writeSecret(s.ctx, value.id, 'token', 'stale-token');
    const again = await (await s.request(`/connectors/${value.id}/refresh`, {})).json();
    expect(again.status).toBe('needs_reauth');
  });
  it('a server that answers with errors is error; one that never answers times out as unreachable', async () => {
    const s = setup();
    expect((await s.add(brokenUrl)).status).toBe('error');
    const value = await saveConnector(s.ctx, {type: 'connector', id: 'hang', name: 'Hang', url: hangingUrl, transport: 'streamableHttp', enabled: true, trusted: false, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()});
    const started = Date.now();
    const checked = await probeConnector(s.ctx, value, {}, 200);
    expect(checked).toMatchObject({status: 'unreachable', statusCode: 'probe_timeout'});
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('explicit refresh and a URL change re-run the check', async () => {
    const s = setup();
    const value = await s.add('https://mcp.does-not-exist.invalid/mcp');
    const fixed = await (await s.request(`/connectors/${value.id}`, {type: 'connector.patch', url: `${remote.base}/mcp`}, 'PATCH')).json();
    expect(fixed.status).toBe('connected');
    await saveConnector(s.ctx, {...fixed, status: 'unreachable', lastCheckedAt: new Date().toISOString()});
    expect((await (await s.request(`/connectors/${value.id}/refresh`, {})).json()).status).toBe('connected');
  });
});

describe('connector health at run time', () => {
  it('does not offer (or contact) a connector whose recent check failed; retries after the recheck window', async () => {
    const s = setup();
    await s.ctx.store.put('alice', 'chat', 'chat-1', {...s.chat});
    const value = await s.add(`${remote.base}/mcp`);
    await recordFailure(s.ctx, value, new McpError(502, 'mcp_unreachable', 'down'));
    expect((await connector(s.ctx, value.id)).status).toBe('unreachable');
    const before = s.calls();
    expect(await getMcpTools(s.ctx, {chatId: 'chat-1', disabledConnectorIds: []})).toEqual([]);
    expect(s.calls()).toBe(before);
    await saveConnector(s.ctx, {...(await connector(s.ctx, value.id)), lastCheckedAt: new Date(Date.now() - RECHECK_MS - 1000).toISOString()});
    expect((await getMcpTools(s.ctx, {chatId: 'chat-1', disabledConnectorIds: []})).length).toBeGreaterThan(0);
    expect((await connector(s.ctx, value.id)).status).toBe('connected');
  });
  it('records an unreachable status when discovery fails during a run', async () => {
    const s = setup();
    await s.ctx.store.put('alice', 'chat', 'chat-1', {...s.chat});
    const value = await saveConnector(s.ctx, {type: 'connector', id: 'gone', name: 'Gone', url: 'https://mcp.does-not-exist.invalid/mcp', transport: 'streamableHttp', enabled: true, trusted: false, disabledTools: [], authStatus: 'none', updatedAt: new Date().toISOString()});
    expect(await getMcpTools(s.ctx, {chatId: 'chat-1', disabledConnectorIds: []})).toEqual([]);
    expect((await connector(s.ctx, value.id)).status).toBe('unreachable');
  });
  it('turn notes: one note while unavailable, none repeated, one when it is available again', async () => {
    const s = setup();
    const value = await s.add('https://mcp.does-not-exist.invalid/mcp');
    const first = await connectorTurnNotes(s.ctx, s.chat, []);
    expect(first).toEqual(["The Docs connector can't be reached right now, so its tools aren't available in this turn."]);
    expect(await connectorTurnNotes(s.ctx, s.chat, first)).toEqual([]);
    expect(await connectorTurnNotes(s.ctx, {...s.chat, disabledConnectorIds: [value.id]}, [])).toEqual([]); // off in this chat: no note
    await saveConnector(s.ctx, {...(await connector(s.ctx, value.id)), status: 'connected'});
    const back = await connectorTurnNotes(s.ctx, s.chat, first);
    expect(back).toEqual(['The Docs connector is available again.']);
    expect(await connectorTurnNotes(s.ctx, s.chat, [...first, ...back])).toEqual([]);
  });
});

describe('MCP progress notifications (parity: MCPClient notifications/progress)', () => {
  it('forwards server progress as tool.progress status events for the running call', async () => {
    const s = setup();
    await s.ctx.store.put('alice', 'chat', 'chat-1', {...s.chat});
    await s.ctx.store.put('alice', 'consent', '127.0.0.1', {type: 'consent', host: '127.0.0.1', allowed: true});
    await s.add(`${remote.base}/mcp`);
    const echo = (await getMcpTools(s.ctx, {chatId: 'chat-1', disabledConnectorIds: []})).find(t => t.name.includes('echo'))!;
    const events: unknown[] = [];
    const result = await echo.execute({text: 'hi'}, {chatId: 'chat-1', runId: 'r1', mode: 'auto', callId: 'call-1', emit: async e => { events.push(e); }});
    expect(JSON.stringify(result)).toContain('hi');
    expect(events).toContainEqual({type: 'tool.progress', callId: 'call-1', kind: 'status', text: 'Halfway there'});
  });
});
