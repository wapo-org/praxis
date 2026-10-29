import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import type { Connector } from '@praxis/protocol';
import type { FeatureContext } from '../../contracts.js';
import { fixtures } from '../../tests/fixture.js';
import { createMcpGateway, createMcpRoutes, getMcpTools } from './index.js';
import { connector, guardedFetch, privateAddress, readSecret, remoteUrl, returnTarget, stateKey, type OAuthState, type McpOptions } from './shared.js';
import { fixtureServer } from './fixture.js';
let remote: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { remote = await fixtureServer(); });
afterAll(async () => { await remote.close(); });
function setup(options: McpOptions = {}) {
  const ctx: FeatureContext = { ...fixtures(), userId: 'alice', fetch, local: true, encryptionKey: randomBytes(32).toString('base64') };
  const app = new Hono().route('/v1', createMcpRoutes(async req => ({ ...ctx, userId: req.headers.get('X-User') ?? 'alice' }), { publicOrigin: 'http://127.0.0.1:8788', ...options }));
  const request = (path: string, data?: unknown, method = data ? 'POST' : 'GET', user = 'alice') => app.request(`/v1${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-User': user }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const add = async (input = {}) => { const response = await request('/connectors', { type: 'connector.input', name: 'Fixture', url: `${remote.base}/mcp`, ...input }); expect(response.status).toBe(201); return await response.json() as Connector; };
  const chat = () => ctx.store.put(ctx.userId, 'chat', 'chat-1', { type: 'chat', id: 'chat-1', disabledConnectorIds: [] });
  const consent = () => request('/consents', { type: 'consent', host: '127.0.0.1', allowed: true });
  return { ctx, app, request, add, chat, consent };
}
const run = { chatId: 'chat-1', runId: 'run-1', mode: 'auto' as const };
describe('connector routes and ownership', () => {
  it('implements CRUD, write-only encrypted headers/tokens, and owner isolation', async () => {
    const s = setup(), value = await s.add({ token: 'private-token', extraHeaders: { 'X-Fixture': 'private-header' } });
    expect(value.headerNames).toEqual(['X-Fixture']); expect(JSON.stringify(value)).not.toContain('private'); expect(JSON.stringify(await s.ctx.store.get('alice', 'mcpSecret', value.id))).not.toContain('private'); expect(await readSecret(s.ctx, value.id, 'token')).toBe('private-token');
    expect((await s.request(`/connectors/${value.id}`, undefined, 'GET', 'bob')).status).toBe(404); expect((await (await s.request('/connectors', undefined, 'GET', 'bob')).json()).items).toEqual([]);
    expect((await (await s.request(`/connectors/${value.id}`, { type: 'connector.patch', name: 'Renamed' }, 'PATCH')).json()).name).toBe('Renamed'); expect(await readSecret(s.ctx, value.id, 'token')).toBe('private-token');
    expect((await s.request(`/connectors/${value.id}`, undefined, 'DELETE')).status).toBe(200); expect((await s.request(`/connectors/${value.id}`)).status).toBe(404); expect((await s.ctx.store.get('alice', 'mcpSecret', value.id))?.deleted).toBe(true);
  });
  it('authenticates encryption owner and clears credentials when endpoint changes', async () => {
    const s = setup(), value = await s.add({ token: 'secret', extraHeaders: { 'X-Fixture': 'header' } }); const secret = (await s.ctx.store.get('alice', 'mcpSecret', value.id))!.value;
    await s.ctx.store.put('bob', 'mcpSecret', value.id, secret); await expect(readSecret({ ...s.ctx, userId: 'bob' }, value.id, 'token')).rejects.toThrow();
    const result = await (await s.request(`/connectors/${value.id}`, { type: 'connector.patch', url: `${remote.base}/sse` }, 'PATCH')).json(); expect(result.authStatus).toBe('none'); expect(result.headerNames).toEqual([]); expect(await readSecret(s.ctx, value.id, 'token')).toBeUndefined();
  });
  it('validates boundaries and previews remote config imports without returning headers', async () => {
    const s = setup(); for (const input of [{ url: 'file:///etc/passwd' }, { url: 'https://u:p@example.com/mcp' }, { extraHeaders: { Host: 'evil' } }, { extraHeaders: { 'X-Test': 'bad\r\nheader' } }, { command: 'node' }]) expect((await s.request('/connectors', { type: 'connector.input', name: 'Bad', url: `${remote.base}/mcp`, ...input })).status).toBe(400);
    const result = await (await s.request('/connectors/discover', { type: 'connector.discover', config: JSON.stringify({ mcpServers: { valid: { url: `${remote.base}/mcp`, headers: { 'X-Fixture': 'not-returned' } }, process: { command: 'node', args: ['server'] } } }) })).json(); expect(result.candidates).toHaveLength(1); expect(result.rejected).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('not-returned');
  });
  it('scopes pagination cursors to user and endpoint', async () => {
    const s = setup(); await s.add(); await s.add(); const first = await (await s.request('/connectors?limit=1')).json(); expect(first.items).toHaveLength(1); expect((await (await s.request(`/connectors?cursor=${first.nextCursor}&limit=1`)).json()).items).toHaveLength(1); expect((await s.request(`/connectors?cursor=${first.nextCursor}`, undefined, 'GET', 'bob')).status).toBe(400);
  });
});
describe('official SDK transports and policy', () => {
  it.each(['streamableHttp', 'sse'])('discovers all pages and executes using %s with secret headers', async transport => {
    const s = setup(); await s.chat(); await s.consent(); const value = await s.add({ transport, url: `${remote.base}/${transport === 'sse' ? 'sse' : 'mcp'}`, token: 'manual-token', extraHeaders: { 'X-Fixture': 'configured-header' }, trusted: true });
    const result = await (await s.request(`/connectors/${value.id}/tools`)).json(); expect(result.items).toHaveLength(4); const tools = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }), echo = tools.find(t => t.description.includes('Echo'))!;
    expect(echo.traits).toContain('readOnly'); expect(await echo.execute({ text: 'hello' }, run)).toMatchObject({ content: [{ text: 'hello' }] }); expect(remote.calls.some(c => c.header === 'configured-header' && c.authorization === 'Bearer manual-token')).toBe(true);
  });
  it('enforces host consent and live tool/chat disable on frozen tools', async () => {
    const s = setup(); await s.chat(); const value = await s.add({ trusted: true }), tools = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }), echo = tools.find(t => t.description.includes('Echo'))!;
    await expect(echo.execute({ text: 'hello' }, run)).rejects.toMatchObject({ code: 'consent_required' }); await s.consent(); expect(await echo.execute({ text: 'hello' }, run)).toMatchObject({ content: [{ text: 'hello' }] });
    await s.request(`/connectors/${value.id}/tools/${echo.name}`, { type: 'connector.tool', enabled: false }, 'PATCH'); await expect(echo.execute({}, run)).rejects.toMatchObject({ code: 'connector_disabled' }); await s.request(`/connectors/${value.id}/tools/echo`, { type: 'connector.tool', enabled: true }, 'PATCH');
    await s.ctx.store.put('alice', 'chat', 'chat-1', { disabledConnectorIds: [value.id] }); await expect(echo.execute({}, run)).rejects.toMatchObject({ code: 'connector_disabled' }); expect(await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] })).toEqual([]);
  });
  it('excludes supplied disabled connectors and enforces trust and plan mode', async () => {
    const s = setup(); await s.chat(); await s.consent(); const value = await s.add(); expect(await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [value.id] })).toEqual([]);
    const tools = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }), echo = tools.find(t => t.description.includes('Echo'))!; expect(echo.traits).toEqual(['destructive', 'openWorld']); await expect(echo.execute({}, { ...run, mode: 'plan' })).rejects.toMatchObject({ code: 'plan_read_only' });
    await s.request(`/connectors/${value.id}`, { type: 'connector.patch', trusted: true }, 'PATCH'); const trusted = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }), safe = trusted.find(t => t.description.includes('Echo'))!; expect(await safe.execute({ text: 'safe' }, { ...run, mode: 'plan' })).toMatchObject({ content: [{ text: 'safe' }] });
    await s.request(`/connectors/${value.id}`, { type: 'connector.patch', trusted: false }, 'PATCH'); await expect(safe.execute({}, run)).rejects.toMatchObject({ code: 'connector_changed' });
  });
  it('rejects cross-chat tools and forces gateway nested calls through injected policy', async () => {
    const s = setup(); await s.chat(); await s.consent(); await s.add(); const catalog = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }); await expect(catalog[0]!.execute({}, { ...run, chatId: 'another' })).rejects.toMatchObject({ code: 'chat_mismatch' });
    const invoke = createMcpGateway(catalog).find(t => t.name === 'mcp_call_tool')!; await expect(invoke.execute({ tool: catalog[0]!.name, arguments: {} }, run)).rejects.toMatchObject({ code: 'policy_unconfigured' });
    const policy = vi.fn(async () => ({ approved: true })); expect(await invoke.execute({ tool: catalog[0]!.name, arguments: { x: 1 } }, { ...run, callTool: policy })).toEqual({ approved: true }); expect(policy).toHaveBeenCalledWith(catalog[0]!.name, { x: 1 });
  });
  it('lists and reads resources and gets prompt arguments with SDK calls', async () => {
    const s = setup(); await s.consent(); const value = await s.add(); expect(await (await s.request(`/connectors/${value.id}/resources`)).json()).toMatchObject({ type: 'page', items: [{ type: 'mcp.resource', uri: 'file:///notes.md' }] });
    expect(await (await s.request(`/connectors/${value.id}/resources/read`, { type: 'mcp.resource.read', uri: 'file:///notes.md' })).json()).toMatchObject({ type: 'mcp.resource.result', contents: [{ text: '# Fixture' }] }); expect(await (await s.request(`/connectors/${value.id}/prompts`)).json()).toMatchObject({ type: 'page', items: [{ type: 'mcp.prompt', name: 'review' }] });
    expect(await (await s.request(`/connectors/${value.id}/prompts/get`, { type: 'mcp.prompt.get', name: 'review', arguments: { code: 'let x = 1' } })).json()).toMatchObject({ type: 'mcp.prompt.result', messages: [{ content: { text: 'Review let x = 1' } }] });
  });
  it.each(['form', 'url'])('routes %s elicitation to injected consent handler', async mode => {
    const elicit = vi.fn(async () => ({ action: 'accept' as const, ...(mode === 'form' ? { content: { color: 'blue' } } : {}) })), s = setup(); await s.chat(); await s.consent(); await s.add(); const catalog = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }, { elicit }), ask = catalog.find(t => t.description === `Fixture: ${mode === 'form' ? 'Ask user' : 'Ask through URL'}`)!;
    const result = await ask.execute({}, run) as { content: { text: string }[] }; expect(JSON.parse(result.content[0]!.text).action).toBe('accept'); expect(elicit).toHaveBeenCalledWith(expect.objectContaining({ mode }), expect.objectContaining({ userId: 'alice', chatId: 'chat-1', runId: 'run-1' }));
  });
  it('declines elicitation when no handler exists', async () => {
    const s = setup(); await s.chat(); await s.consent(); await s.add(); const catalog = await getMcpTools(s.ctx, { chatId: 'chat-1', disabledConnectorIds: [] }); const result = await catalog.find(t => t.description === 'Fixture: Ask user')!.execute({}, run) as { content: { text: string }[] }; expect(JSON.parse(result.content[0]!.text).action).toBe('decline');
  });
});
describe('network and return URL guards', () => {
  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.168.1.2', '100.100.100.200', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])('blocks %s in production', address => { expect(privateAddress(address)).toBe(true); expect(() => remoteUrl(`https://${address.includes(':') ? `[${address}]` : address}/mcp`, false)).toThrow(); });
  it('allows HTTPS and explicit local loopback; rejects redirects and missing production fetch', async () => {
    expect(remoteUrl('https://example.com/mcp', false).hostname).toBe('example.com'); expect(remoteUrl('http://127.0.0.1:8788/mcp', true).protocol).toBe('http:'); expect(() => remoteUrl('http://example.com', false)).toThrow(); const s = setup(); await expect(guardedFetch(s.ctx)(`${remote.base}/redirect`)).rejects.toMatchObject({ code: 'redirect_blocked' }); await expect(guardedFetch({ ...s.ctx, local: false })('https://example.com')).rejects.toMatchObject({ code: 'safe_fetch_unconfigured' }); await expect(guardedFetch(s.ctx, {}, remote.base)('https://other.example')).rejects.toMatchObject({ code: 'cross_origin' });
  });
  it.each(['https://evil.test/callback', 'praxis-app://oauth/other', 'praxis-app://evil/callback', 'praxis-app://oauth/callback?state=evil', 'javascript:alert(1)', 'https://allowed.test/callback#fragment'])('rejects return target %s', raw => { expect(() => returnTarget(raw, { webReturnOrigins: ['https://allowed.test'] })).toThrow(); });
});
describe('official SDK OAuth PKCE DCR and CIMD', () => {
  it('completes DCR+PKCE and redirects with same state, encrypted tokens and single use', async () => {
    remote.setCimd(false); const s = setup(), value = await s.add(); const start = await s.request(`/connectors/${value.id}/oauth/start`, { type: 'oauth.start', returnUrl: 'praxis-app://oauth/callback' }); expect(start.status).toBe(200); const authorization = await start.json(), url = new URL(authorization.url); expect(url.searchParams.get('state')).toBe(authorization.state); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); expect(url.searchParams.get('client_id')).toBe('fixture-client');
    expect((await s.ctx.kv.get<OAuthState>(stateKey(authorization.state)))?.verifier).toMatch(/^v1\./); const redirect = await fetch(authorization.url, { redirect: 'manual' }), callback = new URL(redirect.headers.get('location')!); const response = await s.request(`/connectors/oauth/callback${callback.search}`, undefined, 'GET', ''); expect(response.status).toBe(302); expect(response.headers.get('location')).toBe(`praxis-app://oauth/callback?state=${authorization.state}`);
    expect((await connector(s.ctx, value.id)).authStatus).toBe('connected'); expect(await readSecret(s.ctx, value.id, 'tokens')).toMatchObject({ access_token: 'fixture-access-token' }); expect((await s.request(`/connectors/oauth/callback${callback.search}`, undefined, 'GET', '')).status).toBe(409); expect(JSON.stringify(await (await s.request(`/connectors/${value.id}`)).json())).not.toContain('fixture-access-token');
  });
  it('uses hosted HTTPS client metadata as CIMD client id when supported', async () => {
    remote.setCimd(true); const s = setup({ publicOrigin: 'https://praxis.example' }), value = await s.add(), start = await (await s.request(`/connectors/${value.id}/oauth/start`, { type: 'oauth.start' })).json(); expect(new URL(start.url).searchParams.get('client_id')).toBe('https://praxis.example/v1/oauth/client-metadata.json'); expect(await (await s.request('/oauth/client-metadata.json')).json()).toMatchObject({ redirect_uris: ['https://praxis.example/v1/connectors/oauth/callback'], token_endpoint_auth_method: 'none' }); remote.setCimd(false);
  });
  it('returns same state plus sanitized error on denial', async () => {
    const s = setup(), value = await s.add(), start = await (await s.request(`/connectors/${value.id}/oauth/start`, { type: 'oauth.start', returnUrl: 'praxis-app://oauth/callback' })).json(), response = await s.request(`/connectors/oauth/callback?state=${start.state}&error=secret-description`, undefined, 'GET', ''); expect(response.headers.get('location')).toBe(`praxis-app://oauth/callback?state=${start.state}&error=access_denied`); expect((await connector(s.ctx, value.id)).authStatus).toBe('required');
  });
  it('rejects expired state, changed connectors and wrong authenticated owner', async () => {
    const s = setup(), value = await s.add(), begin = async () => (await (await s.request(`/connectors/${value.id}/oauth/start`, { type: 'oauth.start' })).json()).state as string;
    let state = await begin(); expect((await s.request(`/connectors/oauth/callback?state=${state}&code=x`, undefined, 'GET', 'bob')).status).toBe(404); state = await begin(); const pending = (await s.ctx.kv.get<OAuthState>(stateKey(state)))!; pending.expiresAt = '2000-01-01T00:00:00.000Z'; await s.ctx.kv.set(stateKey(state), pending); expect((await s.request(`/connectors/oauth/callback?state=${state}&code=x`, undefined, 'GET', '')).status).toBe(409);
    state = await begin(); await s.request(`/connectors/${value.id}`, { type: 'connector.patch', url: `${remote.base}/sse` }, 'PATCH'); expect((await s.request(`/connectors/oauth/callback?state=${state}&code=x`, undefined, 'GET', '')).status).toBe(409);
  });
  it('allows only one concurrent callback exchange', async () => {
    const s = setup(), value = await s.add(), start = await (await s.request(`/connectors/${value.id}/oauth/start`, { type: 'oauth.start' })).json(), redirect = await fetch(start.url, { redirect: 'manual' }), callback = new URL(redirect.headers.get('location')!); const responses = await Promise.all([s.request(`/connectors/oauth/callback${callback.search}`, undefined, 'GET', ''), s.request(`/connectors/oauth/callback${callback.search}`, undefined, 'GET', '')]); expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
});
