import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ConnectorSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type Connector,
  type JsonObject,
  type JsonValue,
} from '@praxis/protocol';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { FeatureContext, FeatureTool } from '../../contracts.js';
import { connector, McpError, now, requireConsent, saveConnector, type McpOptions } from './shared.js';
import { recordFailure, skipWithoutContact } from './health.js';
import { resourceTools } from './resources.js';
import { listAllTools, withClient } from './client.js';

export const catalogKey = (ctx: FeatureContext, id: string) =>
  `mcp:catalog:${JSON.stringify([ctx.userId, id])}`;

export const qualifiedName = (value: Connector, name: string) => {
  const slug =
    value.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 16) || 'server';
  const hash = createHash('sha256')
    .update(`${value.id}\0${name}`)
    .digest('hex')
    .slice(0, 12);
  return `mcp__${slug}__${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 25)}_${hash}`;
};

export function toolSpec(value: Connector, tool: Tool): Omit<FeatureTool, 'execute'> {
  const schema: JsonObject = JsonObjectSchema.parse(tool.inputSchema);
  delete schema.$schema;
  delete schema.title;
  schema.type = 'object';
  schema.properties ??= {};

  const traits: FeatureTool['traits'] = [];
  if (value.trusted) {
    if (tool.annotations?.readOnlyHint) traits.push('readOnly');
    if (!tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint !== false) {
      traits.push('destructive');
    }
    if (tool.annotations?.idempotentHint) traits.push('idempotent');
    if (tool.annotations?.openWorldHint !== false) traits.push('openWorld');
  } else {
    traits.push('destructive', 'openWorld');
  }

  return {
    name: qualifiedName(value, tool.name),
    description: `${value.name}: ${tool.description ?? tool.name}`,
    inputSchema: schema,
    source: { type: 'mcp', serverId: value.id, serverName: value.name },
    traits,
  };
}

export async function discoverTools(
  ctx: FeatureContext,
  value: Connector,
  options: McpOptions = {},
): Promise<Tool[]> {
  return (await discoverCatalog(ctx, value, options)).tools;
}

/** Tools plus whether the server offers resources (from its initialize capabilities); cached briefly per connector. */
export async function discoverCatalog(
  ctx: FeatureContext,
  value: Connector,
  options: McpOptions = {},
): Promise<{ tools: Tool[]; resources: boolean }> {
  const key = catalogKey(ctx, value.id);
  const cached = await ctx.kv.get<{ url: string; transport: string; tools: Tool[]; resources?: boolean }>(key);
  if (cached?.url === value.url && cached.transport === value.transport) {
    return { tools: cached.tools, resources: cached.resources === true };
  }
  const { tools, resources } = await withClient(ctx, value, options, async (client) => ({
    tools: await listAllTools(client),
    resources: !!client.getServerCapabilities()?.resources,
  }));
  await ctx.kv.set(key, { url: value.url, transport: value.transport, tools, resources }, 60);
  const latest = await connector(ctx, value.id);
  if (latest.url === value.url) {
    await saveConnector(ctx, { ...latest, toolCount: tools.length, error: undefined, status: 'connected', lastCheckedAt: now(), statusCode: undefined });
  }
  return { tools, resources };
}

export async function checkExecution(
  ctx: FeatureContext,
  frozen: Connector,
  rawName: string,
  run: Parameters<FeatureTool['execute']>[1],
  disabled: string[],
  readOnly: boolean,
) {
  const live = await connector(ctx, frozen.id);
  const chat = await ctx.store.get(ctx.userId, 'chat', run.chatId);
  if (!chat || chat.deleted) {
    throw new McpError(404, 'not_found', 'Chat not found');
  }
  const off = z.array(z.string()).parse(chat.value.disabledConnectorIds ?? []);
  if (
    !live.enabled ||
    disabled.includes(live.id) ||
    off.includes(live.id) ||
    live.disabledTools.includes(rawName)
  ) {
    throw new McpError(403, 'connector_disabled', 'This connector or tool is disabled');
  }
  if (
    live.url !== frozen.url ||
    live.transport !== frozen.transport ||
    (frozen.trusted && !live.trusted)
  ) {
    throw new McpError(
      409,
      'connector_changed',
      'Connector security settings changed; start a new conversation',
    );
  }
  await requireConsent(ctx, live);
  if (run.mode === 'plan' && (!live.trusted || !readOnly)) {
    throw new McpError(403, 'plan_read_only', 'Plan mode requires a trusted read-only MCP tool');
  }
  return live;
}

export async function getMcpTools(
  ctx: FeatureContext,
  options: { chatId: string; disabledConnectorIds: string[] },
  mcp: McpOptions = {},
): Promise<FeatureTool[]> {
  z.object({ chatId: z.string().min(1), disabledConnectorIds: z.array(z.string()) }).parse(options);
  const chat = await ctx.store.get(ctx.userId, 'chat', options.chatId);
  if (!chat || chat.deleted) {
    throw new McpError(404, 'not_found', 'Chat not found');
  }
  const off = z.array(z.string()).parse(chat.value.disabledConnectorIds ?? []);
  const values = (await ctx.store.list(ctx.userId, 'connector'))
    .filter((row) => !row.deleted)
    .map((row) => ConnectorSchema.parse(row.value))
    .filter(
      (value) =>
        value.enabled && !options.disabledConnectorIds.includes(value.id) && !off.includes(value.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const tools: FeatureTool[] = [];
  for (const value of values) {
    // Recently failed or signed-out connectors are not offered (a turn note says why); no network call.
    if (skipWithoutContact(value)) continue;
    try {
      const { tools: definitions, resources } = await discoverCatalog(ctx, value, mcp);
      if (resources) tools.push(...resourceTools(ctx, value, options, mcp));
      for (const definition of definitions) {
        if (value.disabledTools.includes(definition.name)) continue;
        tools.push({
          ...toolSpec(value, definition),
          execute: async (args, run) => {
            if (run.chatId !== options.chatId) {
              throw new McpError(403, 'chat_mismatch', 'MCP tool belongs to a different conversation');
            }
            const argumentsObject = JsonObjectSchema.parse(args);
            const live = await checkExecution(
              ctx,
              value,
              definition.name,
              run,
              options.disabledConnectorIds,
              definition.annotations?.readOnlyHint === true,
            );
            return withClient(
              ctx,
              live,
              mcp,
              async (client) =>
                JsonValueSchema.parse(
                  await client.callTool({ name: definition.name, arguments: argumentsObject }, undefined, {
                    // MCP progress notifications become tool.progress status lines (as the app shows them).
                    onprogress: (p) => {
                      if (!run.emit || !run.callId) return;
                      const text = p.message ?? (p.total ? `${p.progress}/${p.total}` : String(p.progress));
                      void run.emit({ type: 'tool.progress', callId: run.callId, kind: 'status', text }).catch(() => {});
                    },
                  }),
                ),
              run,
            );
          },
        });
      }
    } catch (error) {
      if (!(error instanceof McpError)) throw error;
      await recordFailure(ctx, value, error);
    }
  }
  return tools;
}

/** Optional gateway. Its nested call ALWAYS re-enters the injected policy. Register the catalog as hidden tools. */
export function createMcpGateway(catalog: FeatureTool[]): FeatureTool[] {
  const source = { type: 'builtin' as const };
  const resolve = (name: string) => {
    const tool = catalog.find((t) => t.name === name);
    if (!tool) throw new McpError(404, 'not_found', 'MCP tool not found');
    return tool;
  };
  return [
    {
      name: 'mcp_search_tools',
      description: 'Find connector tools in the frozen catalog.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      source,
      traits: ['readOnly', 'idempotent'],
      execute: async (args) => {
        const { query } = z.object({ query: z.string().max(500) }).parse(args);
        return catalog
          .filter((tool) => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 30)
          .map(({ execute: _, classify: __, ...spec }) => spec) as JsonValue;
      },
    },
    {
      name: 'mcp_describe_tool',
      description: 'Show the schema of a connector tool.',
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string' } },
        required: ['tool'],
      },
      source,
      traits: ['readOnly', 'idempotent'],
      execute: async (args) => {
        const { tool } = z.object({ tool: z.string() }).parse(args);
        const { execute: _, classify: __, ...spec } = resolve(tool);
        return spec as JsonValue;
      },
    },
    {
      name: 'mcp_call_tool',
      description: 'Call a connector tool through approval policy.',
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string' }, arguments: { type: 'object' } },
        required: ['tool', 'arguments'],
      },
      source,
      traits: ['destructive', 'openWorld'],
      execute: async (args, run) => {
        const input = z.object({ tool: z.string(), arguments: JsonObjectSchema }).parse(args);
        const tool = resolve(input.tool);
        if (!run.callTool) {
          throw new McpError(503, 'policy_unconfigured', 'Nested tool policy is unavailable');
        }
        return run.callTool(tool.name, input.arguments);
      },
    },
  ];
}
