import {ConnectorSchema, type Chat, type Connector, type ConnectorStatus} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {connector, McpError, now, readSecret, saveConnector, type McpOptions} from './shared.js';
import {catalogKey, discoverTools} from './tools.js';

/** Statuses whose tools are not offered to the model. */
export const UNAVAILABLE: ReadonlySet<ConnectorStatus> = new Set(['unreachable', 'needs_auth', 'needs_reauth', 'error']);
/** A failed check is trusted this long before run-time discovery tries the server again. */
export const RECHECK_MS = 60_000;
export const PROBE_TIMEOUT_MS = 8_000;

/** Maps a failed handshake to a status and a machine code. Sign-in states depend on whether credentials ever existed. */
export async function classify(ctx: FeatureContext, value: Connector, error: unknown): Promise<{status: ConnectorStatus; code: string}> {
  if (!(error instanceof McpError)) return {status: 'error', code: 'internal_error'};
  if (error.code === 'authorization_required') {
    // A server that was never signed in to needs sign-in; one whose saved credentials stopped working needs it again.
    const hadCredentials = !!(await readSecret(ctx, value.id, 'tokens').catch(() => undefined)) || !!(await readSecret(ctx, value.id, 'token').catch(() => undefined));
    return {status: hadCredentials ? 'needs_reauth' : 'needs_auth', code: error.code};
  }
  if (error.code === 'mcp_unreachable' || error.code === 'probe_timeout') return {status: 'unreachable', code: error.code};
  return {status: 'error', code: error.code};
}

async function record(ctx: FeatureContext, value: Connector, status: ConnectorStatus, code: string | undefined, toolCount?: number): Promise<Connector> {
  const latest = await connector(ctx, value.id);
  // The connector was re-pointed while we checked: this result describes the old endpoint.
  if (latest.url !== value.url || latest.transport !== value.transport) return latest;
  // A failed check drops the cached catalog, so the next attempt really talks to the server.
  if (status !== 'connected') await ctx.kv.del(catalogKey(ctx, value.id));
  return saveConnector(ctx, ConnectorSchema.parse({
    ...latest,
    status,
    lastCheckedAt: now(),
    statusCode: code,
    ...(toolCount === undefined ? {} : {toolCount}),
    ...(status === 'connected' ? {error: undefined} : {}),
  }));
}

/**
 * Health check on create, on credential/URL change and on explicit refresh: the MCP `initialize` handshake
 * plus tool listing, through the guarded egress, bounded by a short timeout. Never throws for remote failures;
 * the result is persisted on the connector. Only a successful handshake yields `connected`.
 */
export async function probeConnector(ctx: FeatureContext, value: Connector, options: McpOptions = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<Connector> {
  await ctx.kv.del(catalogKey(ctx, value.id));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new McpError(502, 'probe_timeout', `${value.name} did not answer in time`)), timeoutMs); });
    const tools = await Promise.race([discoverTools(ctx, value, options), timeout]);
    return await record(ctx, value, 'connected', undefined, tools.length);
  } catch (error) {
    const {status, code} = await classify(ctx, value, error);
    return record(ctx, value, status, code);
  } finally {
    clearTimeout(timer);
  }
}

/** Run-time discovery failure: same classification, persisted so the next turn's note and listing reflect it. */
export async function recordFailure(ctx: FeatureContext, value: Connector, error: unknown): Promise<void> {
  const {status, code} = await classify(ctx, value, error);
  await record(ctx, value, status, code).catch(() => undefined);
}

/** True when the connector's last check failed recently enough (or needs sign-in) that its tools are skipped without contacting it. */
export function skipWithoutContact(value: Connector, clock = Date.now()): boolean {
  if (!value.status || !UNAVAILABLE.has(value.status)) return false;
  if (value.status === 'needs_auth' || value.status === 'needs_reauth') return true;
  return !!value.lastCheckedAt && clock - Date.parse(value.lastCheckedAt) < RECHECK_MS;
}

function note(value: Connector): string {
  const lead = `The ${value.name} connector`;
  switch (value.status) {
    case 'unreachable': return `${lead} can't be reached right now, so its tools aren't available in this turn.`;
    case 'needs_auth': return `${lead} needs the user to sign in (in connector settings), so its tools aren't available in this turn.`;
    case 'needs_reauth': return `${lead} needs the user to sign in again (in connector settings), so its tools aren't available in this turn.`;
    case 'error': return `${lead} isn't working right now (${value.statusCode ?? 'error'}), so its tools aren't available in this turn.`;
    default: return `${lead} is available again.`;
  }
}

/**
 * Turn notes for connectors in this chat whose availability changed since the last note about them: an
 * "unavailable" note while a connector is down, and one "available again" note when it recovers. Read back
 * from the transcript, so the same history always yields the same notes (like the mode note).
 */
export async function connectorTurnNotes(ctx: FeatureContext, chat: Chat, previousNotes: string[]): Promise<string[]> {
  const off = new Set([...chat.disabledConnectorIds]);
  const values = (await ctx.store.list(ctx.userId, 'connector'))
    .filter(r => !r.deleted)
    .map(r => ConnectorSchema.parse(r.value))
    .filter(v => v.enabled && !off.has(v.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const notes: string[] = [];
  for (const value of values) {
    const lead = `The ${value.name} connector`;
    const last = [...previousNotes].reverse().find(n => n.startsWith(lead));
    const down = !!value.status && UNAVAILABLE.has(value.status);
    if (down) {
      const text = note(value);
      if (last !== text) notes.push(text);
    } else if (value.status === 'connected' && last && !last.endsWith('is available again.')) {
      notes.push(note(value));
    }
  }
  return notes;
}
