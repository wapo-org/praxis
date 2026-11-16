import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ConnectorInputSchema, ConnectorPatchSchema, ConnectorSchema, ConsentSchema, JsonObjectSchema, MCPPromptSchema, MCPResourceSchema } from '@praxis/protocol';
import type { FeatureContext } from '../../contracts.js';
import { catalogKey, discoverTools, toolSpec } from './tools.js';
import { withClient } from './client.js';
import { clientMetadata, finishOAuth, startOAuth } from './oauth.js';
import { connector, HeadersSchema, McpError, now, opaqueId, page, remoteUrl, requireConsent, saveConnector, secretKind, writeSecret, type McpOptions } from './shared.js';
export { getMcpTools, createMcpGateway, qualifiedName } from './tools.js';
export type { McpOptions, OAuthState } from './shared.js';

const Input = ConnectorInputSchema.extend({ extraHeaders: HeadersSchema.optional() }).strict();
const Patch = ConnectorPatchSchema.extend({ extraHeaders: HeadersSchema.optional() }).strict();
const ParamId = z.string().min(1).max(200);
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  const text = await c.req.text();
  if (Buffer.byteLength(text) > 1_000_000) throw new McpError(413, 'too_large', 'Request is too large');
  try { return schema.parse(JSON.parse(text)); } catch (error) { if (error instanceof z.ZodError) throw error; throw new McpError(400, 'invalid_json', 'Expected JSON'); }
}
/** Mounted at /v1 after auth EXCEPT public OAuth callback + CIMD. Context provides adapters there with userId ''. */
export function createMcpRoutes(context: (req: Request) => Promise<FeatureContext>, options: McpOptions = {}): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof TypeError) return c.json({ type: 'error', code: 'invalid_input', message: 'Invalid MCP input' }, 400);
    if (error instanceof McpError) return c.json({ type: 'error', code: error.code, message: error.message }, error.status);
    return c.json({ type: 'error', code: 'mcp_failed', message: 'MCP operation failed' }, 502);
  });
  const authenticated = async (req: Request) => { const ctx = await context(req); if (!ctx.userId) throw new McpError(403, 'authentication_required', 'Authentication is required'); return ctx; };
  app.get('/oauth/client-metadata.json', c => c.json({ ...clientMetadata(options), client_id: `${options.publicOrigin}/v1/oauth/client-metadata.json` }));
  app.get('/connectors/oauth/callback', async c => {
    const query = z.object({ state: z.string().regex(/^[A-Za-z0-9_-]{32}$/), code: z.string().min(1).max(8192).optional(), error: z.string().max(500).optional(), iss: z.string().url().optional() }).parse(c.req.query());
    const result = await finishOAuth(await context(c.req.raw), query, options);
    return result.target ? c.redirect(result.target, 302) : c.json({ type: 'ok' });
  });
  app.post('/connectors/discover', async c => {
    const ctx = await authenticated(c.req.raw);
    const input = await body(c, z.object({ type: z.literal('connector.discover'), url: z.string().optional(), config: z.string().max(500_000).optional() }).strict());
    const candidates: object[] = []; const rejected: object[] = [];
    const accept = (name: string, entry: unknown) => {
      try {
        const candidate = z.object({ url: z.string(), transport: z.enum(['streamableHttp', 'sse']).optional(), type: z.enum(['http', 'sse']).optional(), headers: HeadersSchema.optional() }).strict().parse(entry);
        const url = remoteUrl(candidate.url, ctx.local).href;
        candidates.push({ type: 'connector.candidate', name, url, transport: candidate.transport ?? (candidate.type === 'sse' ? 'sse' : 'streamableHttp'), headerNames: Object.keys(candidate.headers ?? {}) });
      } catch { rejected.push({ type: 'connector.rejected', name, reason: 'Only remote HTTP/S configurations without embedded credentials are supported' }); }
    };
    if (input.url) accept(new URL(input.url).hostname, { url: input.url });
    if (input.config) {
      let parsed: unknown; try { parsed = JSON.parse(input.config); } catch { throw new McpError(400, 'invalid_config', 'Expected JSON MCP configuration'); }
      const config = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).strict().parse(parsed);
      for (const [name, entry] of Object.entries(config.mcpServers).slice(0, 100)) accept(name, entry);
    }
    if (!input.url && !input.config) throw new McpError(400, 'invalid_input', 'Supply a remote URL or MCP configuration');
    return c.json({ type: 'connector.discovery', candidates, rejected });
  });
  app.get('/connectors', async c => {
    const ctx = await authenticated(c.req.raw);
    const items = (await ctx.store.list(ctx.userId, 'connector')).filter(r => !r.deleted).map(r => ConnectorSchema.parse(r.value)).sort((a, b) => a.id.localeCompare(b.id));
    return c.json(page(items, c.req.query(), JSON.stringify([ctx.userId, 'connectors'])));
  });
  app.post('/connectors', async c => {
    const ctx = await authenticated(c.req.raw); const input = await body(c, Input); const id = opaqueId();
    const url = remoteUrl(input.url, ctx.local).href;
    if (input.token !== undefined) await writeSecret(ctx, id, 'token', input.token);
    if (input.extraHeaders) await writeSecret(ctx, id, 'headers', input.extraHeaders);
    const value = await saveConnector(ctx, ConnectorSchema.parse({ ...input, id, url, type: 'connector', headerNames: Object.keys(input.extraHeaders ?? {}), authStatus: input.token ? 'connected' : 'none', updatedAt: now() }));
    return c.json(value, 201);
  });
  app.get('/connectors/:id', async c => c.json(await connector(await authenticated(c.req.raw), ParamId.parse(c.req.param('id')))));
  app.patch('/connectors/:id', async c => {
    const ctx = await authenticated(c.req.raw); const id = ParamId.parse(c.req.param('id')); const value = await connector(ctx, id); const input = await body(c, Patch);
    const next = { ...value, ...input, type: 'connector' as const };
    if (input.url) next.url = remoteUrl(input.url, ctx.local).href;
    const targetChanged = next.url !== value.url || next.transport !== value.transport;
    // Do not carry credentials onto a changed remote endpoint, even on the same host.
    if (targetChanged) { await ctx.store.delete(ctx.userId, secretKind, id); next.authStatus = 'none'; next.headerNames = []; next.toolCount = undefined; next.promptsCount = undefined; }
    if (input.token !== undefined) { await writeSecret(ctx, id, 'token', input.token); next.authStatus = input.token ? 'connected' : 'none'; }
    if (input.extraHeaders) { await writeSecret(ctx, id, 'headers', input.extraHeaders); next.headerNames = Object.keys(input.extraHeaders); }
    await ctx.kv.del(catalogKey(ctx, id)); return c.json(await saveConnector(ctx, ConnectorSchema.parse(next)));
  });
  app.delete('/connectors/:id', async c => {
    const ctx = await authenticated(c.req.raw); const id = ParamId.parse(c.req.param('id')); await connector(ctx, id);
    await ctx.store.delete(ctx.userId, 'connector', id); await ctx.store.delete(ctx.userId, secretKind, id); await ctx.kv.del(catalogKey(ctx, id)); return c.json({ type: 'ok' });
  });
  app.get('/connectors/:id/tools', async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id')); const tools = await discoverTools(ctx, value, options);
    return c.json(page(tools.map(tool => ({ type: 'tool.spec', ...toolSpec(value, tool) })), c.req.query(), JSON.stringify([ctx.userId, value.id, 'tools'])));
  });
  app.patch('/connectors/:id/tools/:name', async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id')); const { enabled } = await body(c, z.object({ type: z.literal('connector.tool'), enabled: z.boolean() }).strict());
    const tools = await discoverTools(ctx, value, options); const name = z.string().min(1).max(500).parse(c.req.param('name'));
    const tool = tools.find(tool => tool.name === name || toolSpec(value, tool).name === name);
    if (!tool) throw new McpError(404, 'not_found', 'MCP tool not found');
    return c.json(await saveConnector(ctx, { ...value, disabledTools: enabled ? value.disabledTools.filter(n => n !== tool.name) : [...new Set([...value.disabledTools, tool.name])] }));
  });
  app.post('/connectors/:id/oauth/start', async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id'));
    const input = await body(c, z.object({ type: z.literal('oauth.start'), returnUrl: z.string().url().optional() }).strict());
    return c.json(await startOAuth(ctx, value, input, options));
  });
  for (const kind of ['resources', 'prompts'] as const) app.get(`/connectors/:id/${kind}`, async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id'));
    const query = z.object({ cursor: z.string().max(4000).optional() }).parse(c.req.query());
    return c.json(await withClient(ctx, value, options, async client => {
      if (kind === 'resources') { const result = await client.listResources(query); return { type: 'page', items: result.resources.map(resource => MCPResourceSchema.parse({ ...resource, type: 'mcp.resource' })), nextCursor: result.nextCursor ?? null }; }
      const result = await client.listPrompts(query); return { type: 'page', items: result.prompts.map(prompt => MCPPromptSchema.parse({ ...prompt, type: 'mcp.prompt' })), nextCursor: result.nextCursor ?? null };
    }));
  });
  app.post('/connectors/:id/resources/read', async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id')); await requireConsent(ctx, value);
    if (!value.enabled) throw new McpError(403, 'connector_disabled', 'Connector is disabled');
    const input = await body(c, z.object({ type: z.literal('mcp.resource.read'), uri: z.string().min(1).max(8000) }).strict());
    return c.json(await withClient(ctx, value, options, async client => { const result = await client.readResource({ uri: input.uri }); return { type: 'mcp.resource.result', contents: result.contents.map(v => JsonObjectSchema.parse(v)) }; }));
  });
  app.post('/connectors/:id/prompts/get', async c => {
    const ctx = await authenticated(c.req.raw); const value = await connector(ctx, c.req.param('id')); await requireConsent(ctx, value);
    if (!value.enabled) throw new McpError(403, 'connector_disabled', 'Connector is disabled');
    const input = await body(c, z.object({ type: z.literal('mcp.prompt.get'), name: z.string().min(1).max(500), arguments: z.record(z.string(), z.string()).optional() }).strict());
    return c.json(await withClient(ctx, value, options, async client => { const result = await client.getPrompt({ name: input.name, arguments: input.arguments }); return { type: 'mcp.prompt.result', description: result.description, messages: result.messages.map(v => JsonObjectSchema.parse(v)) }; }));
  });
  app.get('/consents', async c => { const ctx = await authenticated(c.req.raw); return c.json(page((await ctx.store.list(ctx.userId, 'consent')).map(r => ConsentSchema.parse(r.value)), c.req.query(), JSON.stringify([ctx.userId, 'consents']))); });
  app.post('/consents', async c => { const ctx = await authenticated(c.req.raw); const input = await body(c, ConsentSchema); const host = new URL(`https://${input.host}`).hostname.toLowerCase(); if (input.host.toLowerCase() !== host) throw new McpError(400, 'invalid_host', 'Supply a hostname'); const value = { ...input, host, updatedAt: now() }; await ctx.store.put(ctx.userId, 'consent', host, value); return c.json(value); });
  return app;
}
