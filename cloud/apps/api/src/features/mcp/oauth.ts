import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Connector, JsonObject } from '@praxis/protocol';
import type { FeatureContext } from '../../contracts.js';
import { seal, unseal } from '../../secrets.js';
import { probeConnector } from './health.js';
import { callbackTarget, connector, guardedFetch, McpError, now, opaqueId, readSecret, remoteUrl, returnTarget, saveConnector, stateKey, writeSecret, type McpOptions, type OAuthState } from './shared.js';

const active = new Set<string>();
export function clientMetadata(options: McpOptions) {
  if (!options.publicOrigin) throw new McpError(503, 'oauth_unconfigured', 'OAuth public origin is not configured');
  const origin = new URL(options.publicOrigin);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new McpError(503, 'oauth_unconfigured', 'OAuth public origin is invalid');
  return { client_name: 'Praxis', redirect_uris: [`${origin.origin}/v1/connectors/oauth/callback`], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}
class Provider implements OAuthClientProvider {
  constructor(private ctx: FeatureContext, private value: Connector, private record: OAuthState, private options: McpOptions) {}
  get redirectUrl() { return clientMetadata(this.options).redirect_uris[0]!; }
  get clientMetadata() { return clientMetadata(this.options); }
  get clientMetadataUrl() { const origin = new URL(this.redirectUrl).origin; return origin.startsWith('https:') ? `${origin}/v1/oauth/client-metadata.json` : undefined; }
  state() { return this.record.state; }
  clientInformation() { return this.record.client ? Promise.resolve(JSON.parse(unseal(this.record.client, this.ctx.userId, `mcp:${this.value.id}:state:${this.record.state}:client`, this.ctx.encryptionKey!)) as OAuthClientInformationMixed) : readSecret<OAuthClientInformationMixed>(this.ctx, this.value.id, 'client'); }
  async saveClientInformation(value: OAuthClientInformationMixed) {
    await writeSecret(this.ctx, this.value.id, 'client', value);
    this.record.client = seal(JSON.stringify(value), this.ctx.userId, `mcp:${this.value.id}:state:${this.record.state}:client`, this.ctx.encryptionKey);
  }
  tokens() { return readSecret<OAuthTokens>(this.ctx, this.value.id, 'tokens'); }
  async saveTokens(value: OAuthTokens) {
    await writeSecret(this.ctx, this.value.id, 'tokens', value);
    await writeSecret(this.ctx, this.value.id, 'tokenSavedAt', now());
    await saveConnector(this.ctx, { ...await connector(this.ctx, this.value.id), authStatus: 'connected', error: undefined });
  }
  async redirectToAuthorization(url: URL) {
    remoteUrl(url.href, this.ctx.local);
    if (url.searchParams.get('state') !== this.record.state || url.searchParams.get('code_challenge_method') !== 'S256') throw new McpError(502, 'invalid_authorization', 'OAuth server did not support PKCE');
    this.authorizationUrl = url.href;
  }
  authorizationUrl?: string;
  async saveCodeVerifier(verifier: string) { this.record.verifier = seal(verifier, this.ctx.userId, `mcp:${this.value.id}:state:${this.record.state}`, this.ctx.encryptionKey); }
  codeVerifier() {
    if (!this.record.verifier) throw new McpError(409, 'invalid_state', 'OAuth verifier is unavailable');
    return unseal(this.record.verifier, this.ctx.userId, `mcp:${this.value.id}:state:${this.record.state}`, this.ctx.encryptionKey!);
  }
  discoveryState() { return this.record.discovery as unknown as OAuthDiscoveryState | undefined; }
  async saveDiscoveryState(value: OAuthDiscoveryState) {
    const issuer = remoteUrl(String(value.authorizationServerUrl), this.ctx.local);
    const metadata = value.authorizationServerMetadata;
    if (metadata) {
      if (metadata.issuer && new URL(metadata.issuer).href.replace(/\/$/, '') !== issuer.href.replace(/\/$/, '')) throw new McpError(502, 'issuer_mismatch', 'OAuth metadata issuer mismatch');
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint]) if (endpoint) remoteUrl(endpoint, this.ctx.local);
      if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new McpError(502, 'pkce_required', 'OAuth requires S256 PKCE');
    }
    this.record.discovery = JSON.parse(JSON.stringify(value)) as JsonObject;
  }
}
export async function startOAuth(ctx: FeatureContext, value: Connector, input: { returnUrl?: string }, options: McpOptions) {
  if (!ctx.local && !options.consumeOAuthState) throw new McpError(503, 'oauth_state_unconfigured', 'Atomic OAuth state consumption is not configured');
  remoteUrl(clientMetadata(options).redirect_uris[0]!, ctx.local);
  const record: OAuthState = { userId: ctx.userId, connectorId: value.id, connectorUrl: value.url, state: opaqueId(), expiresAt: new Date(Date.now() + 600_000).toISOString(), returnUrl: returnTarget(input.returnUrl, options) };
  const provider = new Provider(ctx, value, record, options);
  const network = guardedFetch(ctx, options);
  // Probe only for WWW-Authenticate discovery hints; connector secrets never go to metadata/AS endpoints.
  const probe = await guardedFetch(ctx, options, new URL(value.url).origin)(value.url, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(10_000) });
  const hints = extractWWWAuthenticateParams(probe); await probe.body?.cancel();
  try {
    const result = await auth(provider, { serverUrl: value.url, resourceMetadataUrl: hints.resourceMetadataUrl, scope: hints.scope, fetchFn: network });
    if (result === 'AUTHORIZED') return { type: 'oauth.authorization' as const, state: record.state, url: record.returnUrl ? callbackTarget(record.returnUrl, record.state) : provider.redirectUrl };
    if (!provider.authorizationUrl || !record.verifier) throw new McpError(502, 'oauth_failed', 'OAuth authorization did not start');
    await ctx.kv.set(stateKey(record.state), JSON.parse(JSON.stringify(record)), 600);
    await saveConnector(ctx, { ...value, authStatus: 'required' });
    return { type: 'oauth.authorization' as const, url: provider.authorizationUrl, state: record.state };
  } catch (error) { if (error instanceof McpError) throw error; throw new McpError(502, 'oauth_failed', 'OAuth authorization could not start'); }
}
export async function finishOAuth(base: FeatureContext, query: { state: string; code?: string; error?: string; iss?: string }, options: McpOptions): Promise<{ target?: string; connectorId: string }> {
  const key = stateKey(query.state);
  if (active.has(key)) throw new McpError(409, 'invalid_state', 'OAuth state has already been used');
  active.add(key);
  try {
    // The local fallback is only atomic within this process. Production requires GETDEL.
    if (!base.local && !options.consumeOAuthState) throw new McpError(503, 'oauth_state_unconfigured', 'Atomic OAuth state consumption is not configured');
    const record = options.consumeOAuthState ? await options.consumeOAuthState(key) : await base.kv.get<OAuthState>(key);
    if (!options.consumeOAuthState) await base.kv.del(key);
    if (!record || record.state !== query.state || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) throw new McpError(409, 'invalid_state', 'OAuth state is invalid or expired');
    if (base.userId && base.userId !== record.userId) throw new McpError(404, 'not_found', 'OAuth state not found');
    const ctx = { ...base, userId: record.userId };
    const value = await connector(ctx, record.connectorId);
    if (value.url !== record.connectorUrl) throw new McpError(409, 'connector_changed', 'Connector changed during authorization');
    const target = returnTarget(record.returnUrl, options);
    try {
      if (query.error || !query.code) throw new McpError(400, 'access_denied', 'OAuth authorization was denied');
      const issuer = record.discovery?.authorizationServerUrl;
      if (query.iss && (typeof issuer !== 'string' || new URL(query.iss).href.replace(/\/$/, '') !== new URL(issuer).href.replace(/\/$/, ''))) throw new McpError(400, 'issuer_mismatch', 'OAuth response issuer mismatch');
      const provider = new Provider(ctx, value, record, options);
      const result = await auth(provider, { serverUrl: value.url, authorizationCode: query.code, fetchFn: guardedFetch(ctx, options) });
      if (result !== 'AUTHORIZED') throw new McpError(502, 'oauth_failed', 'OAuth exchange failed');
      const discovery = record.discovery as { authorizationServerUrl?: string; authorizationServerMetadata?: unknown } | undefined;
      if (discovery?.authorizationServerUrl) await writeSecret(ctx, value.id, 'discovery', { authorizationServerUrl: discovery.authorizationServerUrl, ...(discovery.authorizationServerMetadata ? { metadata: discovery.authorizationServerMetadata } : {}), resource: value.url });
      // Signed in: re-run the handshake so status reflects it (only a successful handshake says connected).
      await probeConnector(ctx, await connector(ctx, value.id), options);
      return { connectorId: value.id, target: target ? callbackTarget(target, record.state) : undefined };
    } catch {
      await saveConnector(ctx, { ...await connector(ctx, value.id), authStatus: 'required' });
      if (target) return { connectorId: value.id, target: callbackTarget(target, record.state, query.error ? 'access_denied' : 'oauth_failed') };
      throw new McpError(400, 'oauth_failed', 'OAuth authorization failed');
    }
  } finally { active.delete(key); }
}
