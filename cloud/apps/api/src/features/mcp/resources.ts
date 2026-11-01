import { z } from 'zod';
import type { Connector, JsonValue } from '@praxis/protocol';
import type { FeatureContext, FeatureTool } from '../../contracts.js';
import { withClient } from './client.js';
import { McpError, type McpOptions } from './shared.js';
import { checkExecution, qualifiedName } from './tools.js';

const MAX_TEXT = 100_000;
/**
 * Reserved raw names (the MCP method names). They are outside the MCP tool-name charset, so a server tool can't
 * share the qualified name; getMcpTools also drops any server tool that claims one.
 */
export const LIST_RESOURCES = 'resources/list';
export const READ_RESOURCE = 'resources/read';
export const RESOURCE_TOOL_NAMES: readonly string[] = [LIST_RESOURCES, READ_RESOURCE];

/**
 * Port of AgentMCP MCPResourceTools (mcp_list_resources / mcp_read_resource). One pair per server that offers
 * resources, so approval and trust follow that server exactly like its read-only tools (the app used one pair
 * with a `server` argument; per-server tools keep the cloud's policy keyed by tool source).
 */
export function resourceTools(ctx: FeatureContext, value: Connector, options: { chatId: string; disabledConnectorIds: string[] }, mcp: McpOptions): FeatureTool[] {
  const source = { type: 'mcp' as const, serverId: value.id, serverName: value.name };
  const guard = async (run: Parameters<FeatureTool['execute']>[1], name: string) => {
    if (run.chatId !== options.chatId) throw new McpError(403, 'chat_mismatch', 'MCP tool belongs to a different conversation');
    return checkExecution(ctx, value, name, run, options.disabledConnectorIds, true);
  };
  return [
    {
      name: qualifiedName(value, LIST_RESOURCES),
      description: `List the resources (documents, files, records) the ${value.name} connector shares. Read one with ${qualifiedName(value, READ_RESOURCE)}.`,
      inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: 'Page cursor from a previous call' } } },
      source,
      traits: ['readOnly', 'idempotent'],
      execute: async (args, run) => {
        const { cursor } = z.object({ cursor: z.string().max(2000).optional() }).parse(args ?? {});
        const live = await guard(run, LIST_RESOURCES);
        return withClient(ctx, live, mcp, async client => {
          const page = await client.listResources(cursor ? { cursor } : {});
          return JSON.parse(JSON.stringify({
            resources: page.resources.slice(0, 200).map(r => ({ uri: r.uri, name: r.name, ...(r.description ? { description: r.description } : {}), ...(r.mimeType ? { mimeType: r.mimeType } : {}) })),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          })) as JsonValue;
        }, run);
      },
    },
    {
      name: qualifiedName(value, READ_RESOURCE),
      description: `Read a resource from the ${value.name} connector by URI (from ${qualifiedName(value, LIST_RESOURCES)}).`,
      inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'Resource URI' } }, required: ['uri'] },
      source,
      traits: ['readOnly', 'idempotent'],
      execute: async (args, run) => {
        const { uri } = z.object({ uri: z.string().min(1).max(4000) }).parse(args);
        const live = await guard(run, READ_RESOURCE);
        return withClient(ctx, live, mcp, async client => {
          const result = await client.readResource({ uri });
          const text = result.contents.map(c => ('text' in c && typeof c.text === 'string' ? c.text : `[binary ${c.mimeType ?? 'content'} omitted: ${c.uri}]`)).join('\n\n');
          return { content: [{ type: 'text', text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[truncated]` : text }], isError: false } as JsonValue;
        }, run);
      },
    },
  ];
}
