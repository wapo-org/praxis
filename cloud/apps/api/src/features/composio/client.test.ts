import {describe, expect, it} from 'vitest';
import {CredentialsUnavailableError} from '@praxis/credentials';
import {COMPOSIO_FIREWALL_HOOK_ID} from '@praxis/protocol';
import {parseTenantId} from '@praxis/types';
import {COMPOSIO_READ_BOUNDARY, classifyMetadata, planBatch, planClassification} from './classify.js';
import {EXECUTE_FIXTURES, fakeComposio, sessionCreated, TOOLS} from './fixture.js';
import {byCodeUnit, chatAccounts, sessionConfig} from './session.js';

const signal = new AbortController().signal;
const tenant = parseTenantId(`tn_${'cd'.repeat(32)}`);
const gmail = {toolkit: 'gmail', connectedAccountId: 'ca_gmail'};
const slack = {toolkit: 'slack', connectedAccountId: 'ca_slack'};

describe('Tool Router session config', () => {
  it('turns the Firewall on and pins each toolkit to the recorded connected account', () => {
    const config = sessionConfig(tenant, [slack, gmail]);
    expect(config.hooks).toEqual([{
      type: 'after_execute', id: COMPOSIO_FIREWALL_HOOK_ID, name: 'Praxis Firewall', applies_to: 'all',
      handler: {type: 'prompt_injection_check', action: 'block'},
    }]);
    expect(config).toMatchObject({
      user_id: tenant, toolkits: {enable: ['gmail', 'slack']},
      connected_accounts: {gmail: ['ca_gmail'], slack: ['ca_slack']},
      instant: false, manage_connections: {enable: false}, workbench: {enable: false}, proxy_execute: {enable: false},
    });
  });

  it('orders toolkits by code unit, independent of input order and locale', () => {
    const accounts = ['b', 'B', 'a', 'é'].map(toolkit => ({toolkit, connectedAccountId: `ca_${toolkit}`}));
    expect(sessionConfig(tenant, accounts).toolkits).toEqual({enable: ['B', 'a', 'b', 'é']});
    expect(sessionConfig(tenant, [...accounts].reverse()).toolkits).toEqual({enable: ['B', 'a', 'b', 'é']});
    expect(['b', 'a', 'a'].sort(byCodeUnit)).toEqual(['a', 'a', 'b']);
  });

  it('refuses to build an unscoped session', () => {
    expect(() => sessionConfig(tenant, [])).toThrow();
  });

  it('applies chat connector scope', () => {
    const chat = {connectorIds: [], disabledConnectorIds: ['composio:slack']};
    expect(chatAccounts([gmail, slack], chat)).toEqual([gmail]);
    expect(chatAccounts([gmail, slack], {connectorIds: ['composio:slack', 'mcp-1'], disabledConnectorIds: []})).toEqual([slack]);
  });
});

describe('Tool Router client', () => {
  it('rejects a session whose echoed config lacks the Firewall hook', async () => {
    const fake = fakeComposio({session: sessionCreated([])});
    await expect(fake.ports.router.createSession(sessionConfig(tenant, [gmail]), signal)).rejects.toThrow();
  });

  it('parses every execute result type from the SDK fixtures', async () => {
    const fake = fakeComposio({execute: {A: EXECUTE_FIXTURES.blocked, B: EXECUTE_FIXTURES.failed}});
    await expect(fake.ports.router.execute('trs_test', {tool_slug: 'A', arguments: {}}, signal))
      .resolves.toMatchObject({result_type: 'blocked', reason: {hook_id: COMPOSIO_FIREWALL_HOOK_ID}});
    await expect(fake.ports.router.execute('trs_test', {tool_slug: 'B', arguments: {}}, signal))
      .resolves.toMatchObject({result_type: 'failed'});
  });

  it('returns null for an unknown tool slug', async () => {
    await expect(fakeComposio().ports.router.tool('NOPE_TOOL', signal)).resolves.toBeNull();
  });

  it('fails over a rate-limited key once through the credential pool, then reports cooling', async () => {
    const keys = {COMPOSIO_API_KEY: 'key-one', COMPOSIO_API_KEY_2: 'key-two'};
    const fake = fakeComposio({keys, execute: {LIMITED: 429}});
    await expect(fake.ports.router.execute('trs_test', {tool_slug: 'LIMITED', arguments: {}}, signal))
      .rejects.toBeInstanceOf(CredentialsUnavailableError);
    const headers = fake.fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-api-key'));
    expect(headers).toEqual(['key-one', 'key-two']);
  });
});

describe('trusted classification', () => {
  it('maps Composio hints, treating anything not purely read-only as an effect', () => {
    expect(classifyMetadata(TOOLS.GMAIL_FETCH_EMAILS)).toEqual(COMPOSIO_READ_BOUNDARY);
    expect(classifyMetadata(TOOLS.GMAIL_SEND_EMAIL)).toMatchObject({decision: 'approve', capabilities: ['write', 'external-egress']});
    expect(classifyMetadata(TOOLS.GMAIL_DELETE_MESSAGE)).toMatchObject({decision: 'approve', destructive: true});
  });

  const lookup = async (slug: string) => TOOLS[slug as keyof typeof TOOLS] ?? null;
  const batch = (...slugs: string[]) => ({tools: slugs.map(tool_slug => ({tool_slug, arguments: {}}))});
  const allowed = new Set(['gmail']);

  it.each([
    ['empty', {tools: []}],
    ['missing tools', {}],
    ['nested meta-tool', batch('COMPOSIO_MULTI_EXECUTE_TOOL')],
    ['oversized', batch(...Array.from({length: 101}, () => 'GMAIL_FETCH_EMAILS'))],
    ['extra keys', {...batch('GMAIL_FETCH_EMAILS'), sync_response_to_workbench: true}],
    ['non-object arguments', {tools: [{tool_slug: 'GMAIL_FETCH_EMAILS', arguments: 'x'}]}],
  ])('denies a malformed batch: %s', async (_name, args) => {
    const plan = await planBatch(args, allowed, lookup);
    expect(plan.kind).toBe('invalid');
    expect(planClassification(plan).decision).toBe('deny');
  });

  it('joins the strictest inner decision and treats unknown slugs as approval-required effects', async () => {
    expect(planClassification(await planBatch(batch('GMAIL_FETCH_EMAILS'), allowed, lookup))).toEqual(COMPOSIO_READ_BOUNDARY);
    expect(planClassification(await planBatch(batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'), allowed, lookup)))
      .toMatchObject({decision: 'approve', untrustedSource: true, capabilities: expect.arrayContaining(['external-egress'])});
    expect(planClassification(await planBatch(batch('MYSTERY_TOOL'), allowed, lookup)))
      .toMatchObject({decision: 'approve', capabilities: ['write', 'external-egress', 'exec']});
  });

  it('plans a connect request when an inner action belongs to an unconnected app', async () => {
    expect(await planBatch(batch('GMAIL_FETCH_EMAILS', 'SLACK_SEND_MESSAGE'), allowed, lookup))
      .toEqual({kind: 'connect', toolkits: ['slack']});
    expect(await planBatch(batch('SLACK_SEND_MESSAGE', 'GMAIL_SEND_EMAIL'), new Set(), lookup))
      .toEqual({kind: 'connect', toolkits: ['gmail', 'slack']});
  });
});
