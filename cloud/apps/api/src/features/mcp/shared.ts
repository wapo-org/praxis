import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { ConnectorSchema, PageQuerySchema, type Connector, type JsonObject } from '@praxis/protocol';
import type { FeatureContext } from '../../contracts.js';
import { seal, unseal } from '../../secrets.js';
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpOptions {
  /** Canonical externally reachable API origin. Never derived from Host headers. */
  publicOrigin?: string;
  webReturnOrigins?: string[];
  /** Production network port: MUST pin resolved public IPs, preserve TLS host, and reject redirects. */
  safeFetch?: typeof fetch;
  /** Atomic Redis GETDEL (or equivalent). Required for production OAuth callbacks. */
  consumeOAuthState?: (key: string) => Promise<OAuthState | null>;
  /** Resolve via the run's consent/elicitation mechanism; absence declines, never accepts. */
  /** Distributed lease (Redis in production) so one instance refreshes a connector's OAuth tokens at a time. */
  lease?: { acquire(key: string, ttlMs: number, ownerId?: string): Promise<string | null>; release(key: string, token: string): Promise<void> };
  elicit?: (request: ElicitRequest['params'], context: { userId: string; connectorId: string; connectorName: string; chatId?: string; runId?: string }) => Promise<ElicitResult>;
}
export interface OAuthState {
  userId: string; connectorId: string; connectorUrl: string; state: string;
  expiresAt: string; returnUrl?: string; verifier?: string; client?: string; discovery?: JsonObject;
}
export class McpError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503, readonly code: string, message: string) { super(message); }
}
export const secretKind = 'mcpSecret';
export const stateKey = (state: string) => `mcp:oauth:${state}`;
export const opaqueId = () => randomBytes(24).toString('base64url');
export const now = () => new Date().toISOString();
export async function connector(ctx: FeatureContext, id: string): Promise<Connector> {
  const row = await ctx.store.get(ctx.userId, 'connector', id);
  if (!row || row.deleted) throw new McpError(404, 'not_found', 'Connector not found');
  return ConnectorSchema.parse(row.value);
}
export async function saveConnector(ctx: FeatureContext, value: Connector) {
  const next = ConnectorSchema.parse({ ...value, updatedAt: now() });
  await ctx.store.put(ctx.userId, 'connector', next.id, next as JsonObject);
  return next;
}
/** Existing authStatus=required is the public needs-reauth state; error carries the machine reason. */
export async function requireReauth(ctx: FeatureContext, value: Connector): Promise<never> {
  const live = await connector(ctx, value.id);
  await saveConnector(ctx, {...live, authStatus: 'required', error: 'needs_reauth'});
  throw new McpError(409, 'authorization_required', `${value.name} needs sign-in in connector settings`);
}
export async function readSecret<T>(ctx: FeatureContext, id: string, slot: string): Promise<T | undefined> {
  const row = await ctx.store.get(ctx.userId, secretKind, id);
  const encrypted = row && !row.deleted ? row.value[slot] : undefined;
  if (typeof encrypted !== 'string') return undefined;
  if (!ctx.encryptionKey) throw new McpError(503, 'encryption_unconfigured', 'Secret storage is not configured');
  return JSON.parse(unseal(encrypted, ctx.userId, `mcp:${id}:${slot}`, ctx.encryptionKey)) as T;
}
export async function writeSecret(ctx: FeatureContext, id: string, slot: string, value: unknown) {
  const row = await ctx.store.get(ctx.userId, secretKind, id);
  const encrypted = seal(JSON.stringify(value), ctx.userId, `mcp:${id}:${slot}`, ctx.encryptionKey);
  await ctx.store.put(ctx.userId, secretKind, id, { ...(row?.deleted ? {} : row?.value), [slot]: encrypted });
}
/** Consent key for a remote URL: host plus any non-default port, the same key provider and tool consent use. */
export const consentHost = (url: string) => new URL(url).host.toLowerCase();

export async function requireConsent(ctx: FeatureContext, value: Connector) {
  const url = new URL(value.url);
  const host = consentHost(value.url), legacy = url.hostname.toLowerCase();
  const exact = await ctx.store.get(ctx.userId, 'consent', host);
  // Records saved before WP-W3 were keyed by hostname only; they still count, unless a host:port record decides.
  const consent = exact && !exact.deleted ? exact : host === legacy ? undefined : await ctx.store.get(ctx.userId, 'consent', legacy);
  if (!consent || consent.deleted || consent.value.allowed !== true) throw new McpError(403, 'consent_required', `AI data consent is required for ${host}`);
}
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(ip, bits, 'ipv6');
export function privateAddress(ip: string) { return blocked.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4'); }
export function remoteUrl(raw: string, local: boolean): URL {
  const url = new URL(z.string().url().max(4096).parse(raw));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || host === '127.0.0.1';
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new McpError(400, 'invalid_url', 'Use an HTTPS remote URL without credentials or fragments');
  if (!(local && loopback) && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal' || (isIP(host) && privateAddress(host)))) throw new McpError(400, 'unsafe_url', 'Private and metadata hosts are blocked');
  return url;
}
export function guardedFetch(ctx: FeatureContext, options: McpOptions = {}, origin?: string, headers?: Record<string, string>): typeof fetch {
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = remoteUrl(raw, ctx.local);
    if (origin && url.origin !== origin) throw new McpError(400, 'cross_origin', 'MCP transport endpoints must stay on the connector origin');
    if (!ctx.local) {
      if (!options.safeFetch) throw new McpError(503, 'safe_fetch_unconfigured', 'Production MCP network policy is not configured');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new McpError(400, 'unsafe_url', 'Private and metadata hosts are blocked');
    }
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
    for (const [key, value] of Object.entries(headers ?? {})) requestHeaders.set(key, value);
    const response = await (options.safeFetch ?? ctx.fetch)(input, { ...init, headers: requestHeaders, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new McpError(400, 'redirect_blocked', 'Remote redirects are blocked'); }
    return response;
  };
}
export function returnTarget(raw: string | undefined, options: McpOptions): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search) throw new McpError(400, 'invalid_return_url', 'OAuth return URL is not allowed');
  const native = url.protocol === 'praxis-app:' && url.hostname === 'oauth' && url.pathname === '/callback' && !url.port;
  const web = url.protocol === 'https:' && (options.webReturnOrigins ?? []).includes(url.origin);
  if (!native && !web) throw new McpError(400, 'invalid_return_url', 'OAuth return URL is not allowed');
  return url.href;
}
export function callbackTarget(target: string, state: string, error?: string) {
  const url = new URL(target); url.searchParams.set('state', state); if (error) url.searchParams.set('error', error); return url.href;
}
export function page<T>(items: T[], query: unknown, scope: string) {
  const parsed = PageQuerySchema.parse(query); let offset = 0;
  if (parsed.cursor) {
    try { const cursor = z.object({ scope: z.literal(scope), offset: z.number().int().nonnegative() }).parse(JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString())); offset = cursor.offset; }
    catch { throw new McpError(400, 'invalid_cursor', 'Invalid page cursor'); }
  }
  const end = offset + parsed.limit;
  return { type: 'page' as const, items: items.slice(offset, end), nextCursor: end < items.length ? Buffer.from(JSON.stringify({ scope, offset: end })).toString('base64url') : null };
}
export const HeadersSchema = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().max(8192).refine(v => !/[\r\n]/.test(v))).superRefine((value, ctx) => {
  if (Object.keys(value).length > 32 || Object.keys(value).some(k => /^(host|cookie|connection|content-length|transfer-encoding|proxy-.*|mcp-.*)$/i.test(k))) ctx.addIssue({ code: 'custom', message: 'Reserved or excessive connector headers' });
});
