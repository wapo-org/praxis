import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ElicitRequestSchema, ElicitResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Connector } from '@praxis/protocol';
import type { FeatureContext } from '../../contracts.js';
import { connector, guardedFetch, McpError, readSecret, requireReauth, type McpOptions } from './shared.js';
import { ensureFreshTokens } from './refresh.js';

export async function withClient<T>(ctx: FeatureContext, value: Connector, options: McpOptions, work: (client: Client) => Promise<T>, run?: { chatId: string; runId: string }, retried = false): Promise<T> {
  const liveStatus = await connector(ctx, value.id);
  if (liveStatus.authStatus === 'required') throw new McpError(409, 'authorization_required', `${value.name} needs sign-in in connector settings`);
  const extra = await readSecret<Record<string, string>>(ctx, value.id, 'headers') ?? {};
  const token = await readSecret<string>(ctx, value.id, 'token');
  // Refreshes OAuth tokens shortly before expiry; after a 401 the retry below forces one refresh.
  const oauth: OAuthTokens | undefined = token ? undefined : await ensureFreshTokens(ctx, value, options, retried);
  if (!token && !oauth && await readSecret(ctx, value.id, 'tokens')) return requireReauth(ctx, value);
  const headers = { ...extra, ...(token || oauth?.access_token ? { Authorization: `Bearer ${token || oauth?.access_token}` } : {}) };
  // Auth discovery/registration is explicit. Never open a browser or register clients during an agent call.
  const network = guardedFetch(ctx, options, new URL(value.url).origin, headers);
  const transport = value.transport === 'sse'
    ? new SSEClientTransport(new URL(value.url), { fetch: network })
    : new StreamableHTTPClientTransport(new URL(value.url), { fetch: network, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 } });
  const client = new Client({ name: 'Praxis', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    if ('url' in request.params) {
      const { remoteUrl } = await import('./shared.js'); remoteUrl(request.params.url, ctx.local);
    }
    if (!options.elicit) return { action: 'decline' };
    return ElicitResultSchema.parse(await options.elicit(request.params, { userId: ctx.userId, connectorId: value.id, connectorName: value.name, ...run }));
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); void client.close(); }, 30_000);
  try {
    await client.connect(transport, { signal: controller.signal, timeout: 15_000 });
    return await work(client);
  } catch (error) {
    const status = (error as { code?: number }).code;
    if (status === 401 || status === 403 || (error as Error).name === 'UnauthorizedError') {
      if (!retried && !token && oauth?.refresh_token) {
        await client.close().catch(() => {});
        return withClient(ctx, value, options, work, run, true);
      }
      return requireReauth(ctx, value);
    }
    if (error instanceof McpError) throw error;
    // Remote errors may echo authorization headers or request bodies. Do not return them.
    throw new McpError(502, 'mcp_failed', 'The remote MCP operation failed');
  } finally { clearTimeout(timeout); await client.close().catch(() => {}); }
}
export async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []; const seen = new Set<string>(); let cursor: string | undefined; let bytes = 0;
  for (let i = 0; i < 20; i++) {
    const result = await client.listTools(cursor ? { cursor } : {});
    for (const tool of result.tools) {
      bytes += Buffer.byteLength(JSON.stringify(tool));
      if (tools.length >= 500 || bytes > 4_000_000) throw new McpError(413, 'catalog_too_large', 'MCP tool catalog exceeds supported limits');
      if (tools.some(t => t.name === tool.name)) throw new McpError(502, 'invalid_catalog', 'MCP tool names must be unique');
      tools.push(tool);
    }
    if (!result.nextCursor) return tools;
    if (seen.has(result.nextCursor)) throw new McpError(502, 'invalid_catalog', 'MCP pagination repeated a cursor');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new McpError(413, 'catalog_too_large', 'MCP pagination exceeds supported limits');
}
