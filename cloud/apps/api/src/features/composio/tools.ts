import {z} from 'zod';
import {CredentialsUnavailableError} from '@praxis/credentials';
import {toolError, type AgentTool, type ToolClassification, type ToolContext, type ToolResult} from '@praxis/agent';
import {
  COMPOSIO_FIREWALL_HOOK_ID, COMPOSIO_LIMITS, COMPOSIO_META_TOOL_NAMES as NAMES, COMPOSIO_TOOL_HINTS, ComposioConnectRequiredSchema,
  ComposioGetSchemasInputSchema, ComposioMultiExecuteInputSchema, ComposioSearchInputSchema, composioConnectorId,
  type Chat, type ComposioConnectedAccount, type JsonObject, type JsonValue, type ToolError,
} from '@praxis/protocol';
import type {ExecuteResult, ToolMetadata} from './client.js';
import {COMPOSIO_BATCH_BOUNDARY, COMPOSIO_READ_BOUNDARY, planBatch, planClassification, type BatchAction} from './classify.js';
import {COMPOSIO_TEXT as TEXT} from './constants.js';
import type {ComposioPorts} from './ports.js';
import {chatAccounts, sessionConfig} from './session.js';

/** Per-turn memo: one Tool Router session and one metadata lookup per slug, never shared across users or turns. */
interface TurnRouter {
  accounts(): Promise<ComposioConnectedAccount[]>;
  toolkits(): Promise<ReadonlySet<string>>;
  session(signal: AbortSignal): Promise<string>;
  metadata(slug: string): Promise<ToolMetadata | null>;
}

function turnRouter(ports: ComposioPorts, userId: string, chat: Chat): TurnRouter {
  let accounts: Promise<ComposioConnectedAccount[]> | undefined;
  let session: Promise<string> | undefined;
  const metadata = new Map<string, Promise<ToolMetadata | null>>();
  const router: TurnRouter = {
    accounts() {
      accounts ??= ports.connectedAccounts(userId).then(rows => chatAccounts(rows, chat));
      return accounts;
    },
    async toolkits() {
      return new Set((await router.accounts()).map(account => account.toolkit.toLowerCase()));
    },
    session(signal) {
      session ??= (async () => {
        const config = sessionConfig(await ports.tenantId(userId), await router.accounts());
        return (await ports.router.createSession(config, signal)).session_id;
      })();
      // A failed creation is retried by the next call instead of pinning the error for the turn.
      session.catch(() => { session = undefined; });
      return session;
    },
    metadata(slug) {
      let found = metadata.get(slug);
      if (!found) {
        // Lookup failures classify as unknown, which still requires approval; the same answer is reused at dispatch.
        found = ports.router.tool(slug, AbortSignal.timeout(COMPOSIO_LIMITS.REQUEST_TIMEOUT_MS)).catch(() => null);
        metadata.set(slug, found);
      }
      return found;
    },
  };
  return router;
}

export function composioTools(ports: ComposioPorts | undefined, userId: string, chat: Chat): AgentTool[] {
  if (!ports) return [];
  const turn = turnRouter(ports, userId, chat);
  return [
    tool(NAMES.search, TEXT.search, ComposioSearchInputSchema, ['readOnly', 'openWorld'], COMPOSIO_READ_BOUNDARY,
      (args, context) => search(ports, turn, args, context)),
    tool(NAMES.schemas, TEXT.schemas, ComposioGetSchemasInputSchema, ['readOnly', 'openWorld'], COMPOSIO_READ_BOUNDARY,
      args => schemas(turn, args)),
    {
      ...tool(NAMES.multiExecute, TEXT.multiExecute, ComposioMultiExecuteInputSchema, ['openWorld'], COMPOSIO_BATCH_BOUNDARY,
        (args, context) => multiExecute(ports, turn, args, context)),
      async classifyBoundary(args) {
        return planClassification(await planBatch(args, await turn.toolkits(), slug => turn.metadata(slug)));
      },
    },
  ];
}

type Execute = (args: JsonValue, context: ToolContext) => Promise<ToolResult>;
function tool(name: string, description: string, schema: z.ZodObject, traits: AgentTool['spec']['traits'],
  boundary: ToolClassification, execute: Execute): AgentTool {
  return {
    spec: {type: 'tool.spec', name, description, inputSchema: z.toJSONSchema(schema) as JsonObject, source: {type: 'builtin'}, traits},
    boundary,
    async execute(args, context) {
      try {
        return await execute(args, context);
      } catch (error) {
        if (context.signal.aborted) throw error;
        return failure(error instanceof z.ZodError
          ? toolError('schema', 'Invalid app tool arguments.')
          : transportError(error, true));
      }
    },
  };
}

async function search(ports: ComposioPorts, turn: TurnRouter, args: JsonValue, context: ToolContext): Promise<ToolResult> {
  const input = ComposioSearchInputSchema.parse(args);
  if (!(await turn.accounts()).length) return untrusted(ports, context, {results: [], hint: TEXT.noApps});
  const allowed = await turn.toolkits();
  const found = await ports.router.search(await turn.session(context.signal), {queries: input.queries}, context.signal);
  const toolSchemas = Object.values(found.tool_schemas).filter(entry => allowed.has(entry.toolkit.toLowerCase()));
  const offered = new Set(toolSchemas.map(entry => entry.tool_slug));
  const results = found.results.map(result => ({
    ...result,
    primary_tool_slugs: result.primary_tool_slugs.filter(slug => offered.has(slug)),
    related_tool_slugs: result.related_tool_slugs.filter(slug => offered.has(slug)),
  }));
  const empty = results.every(result => !result.primary_tool_slugs.length);
  return untrusted(ports, context, {
    results, tool_schemas: toolSchemas,
    toolkit_connection_statuses: found.toolkit_connection_statuses.filter(status => allowed.has(status.toolkit.toLowerCase())),
    ...(empty ? {hint: TEXT.noApps} : {}),
  });
}

async function schemas(turn: TurnRouter, args: JsonValue): Promise<ToolResult> {
  const {tool_slugs: slugs} = ComposioGetSchemasInputSchema.parse(args);
  const allowed = await turn.toolkits();
  const found = await Promise.all(slugs.map(async slug => ({slug, metadata: await turn.metadata(slug)})));
  const unconnected = found.flatMap(({metadata}) => metadata && !allowed.has(metadata.toolkit.slug.toLowerCase())
    ? [metadata.toolkit.slug.toLowerCase()] : []);
  if (unconnected.length) return connectRequired(unconnected);
  const tools = found.map(({slug, metadata}) => metadata
    ? {tool_slug: slug, toolkit: metadata.toolkit.slug, description: metadata.description, input_schema: metadata.input_parameters}
    : {tool_slug: slug, error: 'Unknown tool slug.'});
  return {isError: false, tainted: true, content: [{type: 'untrusted-data', source: 'composio', tools: toJson(tools)}]};
}

async function multiExecute(ports: ComposioPorts, turn: TurnRouter, args: JsonValue, context: ToolContext): Promise<ToolResult> {
  ComposioMultiExecuteInputSchema.parse(args);
  const plan = await planBatch(args, await turn.toolkits(), slug => turn.metadata(slug));
  if (plan.kind === 'invalid') return failure(toolError('schema', 'Invalid app tool batch.'));
  if (plan.kind === 'connect') return connectRequired(plan.toolkits);
  if (!(await turn.accounts()).length) return untrusted(ports, context, {results: [], hint: TEXT.noApps});
  const sessionId = await turn.session(context.signal);
  await ports.recordUsage({
    userId: context.userId, runId: context.runId, callId: context.callId,
    period: new Date().toISOString().slice(0, 7), executions: plan.actions.length,
  });
  const results = await inBatches(plan.actions, action => runAction(ports, sessionId, action, context.signal));
  const blocked = results.every(result => !result.ok && result.error.code === 'upstream-firewall');
  if (results.every(result => !result.ok)) {
    return untrusted(ports, context, {results}, blocked ? toolError('upstream-firewall', TEXT.firewallBlocked) : toolError('upstream', TEXT.appFailed));
  }
  return untrusted(ports, context, {results});
}

type ActionResult = {tool_slug: string; ok: true; data: JsonValue} | {tool_slug: string; ok: false; error: ToolError; detail?: string};

/** Inner actions run as listed, at most a few at a time, with results kept in the checked order. */
async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let at = 0; at < items.length; at += COMPOSIO_LIMITS.PARALLEL_CALLS_MAX) {
    results.push(...await Promise.all(items.slice(at, at + COMPOSIO_LIMITS.PARALLEL_CALLS_MAX).map(run)));
  }
  return results;
}

async function runAction(ports: ComposioPorts, sessionId: string, action: BatchAction, signal: AbortSignal): Promise<ActionResult> {
  const slug = action.tool_slug;
  let outcome: ExecuteResult;
  try {
    outcome = await ports.router.execute(sessionId, {tool_slug: slug, arguments: action.arguments}, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    const readOnly = action.metadata?.tags.includes(COMPOSIO_TOOL_HINTS.readOnly) === true;
    return {tool_slug: slug, ok: false, error: transportError(error, readOnly)};
  }
  switch (outcome.result_type) {
    case 'completed': {
      const firewall = outcome.hook_results?.find(hook => hook.id === COMPOSIO_FIREWALL_HOOK_ID);
      // Only an explicit Firewall pass releases a result; a missing or unavailable check fails closed.
      if (firewall?.status !== 'evaluated' || firewall.outcome !== 'continue') {
        return {tool_slug: slug, ok: false, error: toolError('upstream', TEXT.firewallUnchecked)};
      }
      return {tool_slug: slug, ok: true, data: toJson(outcome.data)};
    }
    case 'failed':
      return {tool_slug: slug, ok: false, error: toolError('upstream', TEXT.appFailed), ...(outcome.error ? {detail: outcome.error} : {})};
    case 'blocked':
      return {tool_slug: slug, ok: false, error: toolError('upstream-firewall', TEXT.firewallBlocked)};
    case 'input_required':
      return {tool_slug: slug, ok: false, error: toolError('upstream', TEXT.inputRequired)};
  }
}

function transportError(error: unknown, readOnly: boolean): ToolError {
  if (error instanceof CredentialsUnavailableError && error.detail === 'cooling') {
    return {code: 'upstream', message: TEXT.rateLimited, remediation: readOnly ? TEXT.retryRead : TEXT.checkEffect};
  }
  const message = error instanceof z.ZodError ? TEXT.malformed : TEXT.unavailable;
  return {code: 'upstream', message, remediation: readOnly ? TEXT.unavailableRemediation : TEXT.checkEffect};
}

/** Every Composio payload is wrapped as untrusted data, whatever the Firewall decided; oversized payloads spill. */
async function untrusted(ports: ComposioPorts, context: ToolContext, value: Record<string, unknown>, error?: ToolError): Promise<ToolResult> {
  const json = toJson(value);
  const text = JSON.stringify(json);
  let body: JsonObject = {type: 'untrusted-data', source: 'composio', ...(json as JsonObject)};
  if (text.length > COMPOSIO_LIMITS.RESULT_CHARACTERS_MAX) {
    const outputRef = await ports.spill({userId: context.userId, runId: context.runId, callId: context.callId, text});
    body = {type: 'untrusted-data', source: 'composio', truncated: true, outputRef,
      preview: text.slice(0, COMPOSIO_LIMITS.RESULT_CHARACTERS_MAX)};
  }
  return error ? {isError: true, error, tainted: true, content: [body]} : {isError: false, tainted: true, content: [body]};
}

function connectRequired(toolkits: readonly string[]): ToolResult {
  const unique = [...new Set(toolkits)].sort();
  const request = ComposioConnectRequiredSchema.parse({
    type: 'composio.connect-required',
    toolkits: unique.map(toolkit => ({toolkit, connectorId: composioConnectorId(toolkit)})),
  });
  const error = toolError('connection-required', TEXT.connect);
  return {isError: true, error, content: [request, {type: 'text', text: JSON.stringify(error)}]};
}

function failure(error: ToolError): ToolResult {
  return {isError: true, error, content: [{type: 'text', text: JSON.stringify(error)}]};
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue;
}
