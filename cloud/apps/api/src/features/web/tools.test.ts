import {expect, it, vi} from 'vitest';
import {memoryCooldownStore, pool} from '@praxis/credentials';
import {WEB_TOOL_LIMITS as LIMITS, JsonValueSchema, type JsonValue} from '@praxis/protocol';
import type {ToolContext} from '@praxis/agent';
import {assertPublicUrl} from '../../adapters/security.js';
import type {WebPorts} from './ports.js';
import {webPageCacheKey, webToolClassifier, webTools} from './tools.js';

function fixture() {
  const cache = new Map<string, unknown>();
  const accounting = {admitAttempt: vi.fn(async () => true), reserve: vi.fn(async () => 'reserved' as const), settle: vi.fn(async () => {}), release: vi.fn(async () => {})};
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({results: [{title: 'Example', url: 'https://example.com', highlights: ['Snippet']}]}));
  const ports: WebPorts = {
    pools: {exa: pool('EXA_API_KEY', {EXA_API_KEY: 'fake-one', EXA_API_KEY_2: 'fake-two'}, {service: 'exa'}),
      firecrawl: pool('FIRECRAWL_API_KEY', {FIRECRAWL_API_KEY: 'fake-firecrawl'}, {service: 'firecrawl'})},
    cooldowns: memoryCooldownStore(), accounting, fetch: fetcher,
    egress: vi.fn<typeof fetch>(async () => new Response(null)),
    assertPublicUrl: url => assertPublicUrl(url, {resolve: async () => [{address: '93.184.216.34', family: 4}]}),
    cache: {async get<T>(key: string) {return (cache.get(key) ?? null) as T | null;}, async set(key, value) {cache.set(key, value);}},
    spill: vi.fn(async () => 'spill-id'),
  };
  const context: ToolContext = {userId: 'user', runId: 'run', callId: 'call', chatId: 'chat', mode: 'auto', signal: new AbortController().signal,
    callTool: vi.fn(), elicit: vi.fn(), emit: vi.fn()};
  const tools = webTools(ports);
  const search = (args: JsonValue = {query: 'news'}) => tools[0]!.execute(args, context);
  const read = (args: JsonValue = {url: 'https://example.com/article'}) => tools[1]!.execute(args, context);
  return {cache, accounting, fetcher, ports, context, search, read};
}
it('pins Exa auto, limits results, reserves before dispatch and settles platform usage without exposing keys', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async () => {
    expect(f.accounting.reserve).toHaveBeenCalledWith(expect.objectContaining({userId: 'user', service: 'exa', estimateMicroUsd: 7000}));
    return Response.json({results: [{title: 'Example', url: 'https://example.com', highlights: ['Snippet']}]});
  });
  const result = await f.search();
  expect(result.isError).toBe(false);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body));
  expect(body).toEqual({query: 'news', type: 'auto', numResults: 8, contents: {highlights: true}});
  expect(f.accounting.settle).toHaveBeenCalledWith(expect.objectContaining({payer: 'platform', actualMicroUsd: 7000, slot: 1}));
  expect(JSON.stringify(result)).not.toContain('fake-one');
  expect(result.content[0]).toMatchObject({type: 'untrusted-data', results: [{highlight: 'Snippet'}]});
});
it('fails over through the pool on 429 and records the serving slot', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValueOnce(new Response(null, {status: 429}));
  expect((await f.search()).isError).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.accounting.settle).toHaveBeenCalledWith(expect.objectContaining({slot: 2}));
});
it.each(['denied', 'duplicate'] as const)('does not dispatch a %s spend admission', async admission => {
  const f = fixture();
  f.accounting.reserve.mockImplementation(async () => admission as 'reserved');
  expect((await f.search()).isError).toBe(true);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([{query: ''}, {query: 'x', numResults: 11}, {query: 'x', type: 'deep'}, {query: 'x', includeDomains: ['localhost']}])('rejects invalid search input %j', async args => {
  const f = fixture();
  expect(await f.search(JsonValueSchema.parse(args))).toMatchObject({isError: true, error: {code: 'schema'}});
  expect(f.accounting.reserve).not.toHaveBeenCalled();
});
it.each(['http://127.0.0.1', 'https://10.0.0.1', 'https://[::1]', 'file:///etc/passwd', 'https://user:pass@example.com'])('refuses unsafe URL %s before paid dispatch', async url => {
  const f = fixture();
  expect(await f.read({url})).toMatchObject({isError: true, error: {code: 'policy-denied'}});
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.accounting.reserve).not.toHaveBeenCalled();
});
it('pins markdown-only scraping without PDF parsing, caps and spills long pages, then serves a validated shared cache hit', async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(Response.json({success: true, data: {markdown: 'x'.repeat(2_000_000)}}));
  const result = await f.read();
  expect(result.content[0]).toMatchObject({type: 'untrusted-data', truncated: true, outputRef: 'spill-id'});
  expect(String(result.content[0]!.markdown)).toHaveLength(LIMITS.PAGE_CHARACTERS_MAX);
  expect(f.ports.spill).toHaveBeenCalledWith(expect.objectContaining({text: 'x'.repeat(2_000_000)}));
  expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]!.body))).toMatchObject({formats: ['markdown'], onlyMainContent: true, parsers: []});
  await f.read();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.accounting.settle).toHaveBeenLastCalledWith(expect.objectContaining({actualMicroUsd: 0}));
});
it('treats malformed or unavailable cache as a miss and never shares URLs with query parameters', async () => {
  const f = fixture();
  f.cache.set(webPageCacheKey('https://example.com/article'), {url: 'https://other.com', markdown: 'wrong'});
  f.fetcher.mockImplementation(async () => Response.json({success: true, data: {markdown: 'page'}}));
  await f.read();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await f.read({url: 'https://example.com/?token=private'});
  await f.read({url: 'https://example.com/?token=private'});
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  expect([...f.cache.keys()].join()).not.toContain('private');
});
it('releases reservations on provider failures and does not leak provider messages', async () => {
  const f = fixture();
  f.fetcher.mockRejectedValue(new Error('fake-one secret provider response'));
  const result = await f.search();
  expect(result).toMatchObject({isError: true, error: {code: 'upstream', remediation: expect.any(String)}});
  expect(JSON.stringify(result)).not.toContain('fake-one');
  expect(f.accounting.release).toHaveBeenCalledTimes(1);
  expect(f.accounting.settle).not.toHaveBeenCalled();
});
it('holds the reservation when settlement fails instead of releasing a billed call', async () => {
  const f = fixture();
  f.accounting.settle.mockRejectedValue(new Error('database down'));
  expect((await f.search()).isError).toBe(true);
  expect(f.accounting.release).not.toHaveBeenCalled();
});
it('keeps the catalog stable while disabled or unconfigured and exposes structural taint classification', async () => {
  const f = fixture();
  const enabled = webTools(f.ports), disabled = webTools(f.ports, false), unavailable = webTools(undefined);
  expect(enabled.map(t => t.spec)).toEqual(disabled.map(t => t.spec));
  expect(enabled.map(t => t.spec)).toEqual(unavailable.map(t => t.spec));
  expect(await disabled[0]!.execute({query: 'x'}, f.context)).toMatchObject({isError: true, error: {code: 'policy-denied'}});
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(webToolClassifier.classify({tool: 'web_read', args: {url: 'https://example.com'}})).toEqual({capabilities: ['read', 'external-egress'], decision: 'allow', untrustedSource: true});
});
it('falls through an unavailable cache and returns bounded provider data', async () => {
  const f = fixture();
  f.ports.cache.get = async () => {throw new Error('Redis down');};
  f.ports.cache.set = async () => {throw new Error('Redis down');};
  f.fetcher.mockResolvedValue(Response.json({success: true, data: {markdown: 'Article'}}));
  expect(await f.read()).toMatchObject({isError: false, content: [{markdown: 'Article'}]});
});
it('does not dispatch when the global attempt allowance is exhausted', async () => {
  const f = fixture();
  f.accounting.admitAttempt.mockResolvedValue(false);
  expect(await f.search()).toMatchObject({isError: true, error: {code: 'budget'}});
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.accounting.release).toHaveBeenCalledTimes(1);
});
it('marks paged stored output as untrusted for fresh thin-harness turns', () => {
  expect(webToolClassifier.classify({tool: 'read_tool_output', args: {id: 'output', offset: 0}})).toEqual({
    capabilities: ['read'], decision: 'allow', untrustedSource: true,
  });
});
