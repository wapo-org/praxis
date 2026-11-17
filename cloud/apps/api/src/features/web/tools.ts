import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ToolBoundaryError, type AgentTool, type ToolClassification, type ToolContext} from '@praxis/agent';
import {exaSearchMaxMicroUsd, FIRECRAWL_BASE_PAGE_CREDITS, FIRECRAWL_CREDIT_MICRO_USD} from '@praxis/spend';
import {WEB_TOOL_LIMITS as LIMITS, WEB_TOOL_NAMES, WebPageSchema, WebReadInputSchema, WebSearchInputSchema,
  type JsonObject, type JsonValue, type WebSpendCall} from '@praxis/protocol';
import {WEB_CACHE_PREFIX, WEB_TEXT} from './constants.js';
import type {WebPorts} from './ports.js';
import {newDispatch, webRequest, type WebDispatch} from './provider.js';

const ExaResponse = z.object({results: z.array(z.object({
  title: z.string().nullable().optional(), url: z.url(), publishedDate: z.string().optional(),
  highlights: z.array(z.string()).optional(),
})).max(LIMITS.SEARCH_RESULTS_MAX)});
const FirecrawlResponse = z.object({success: z.literal(true), data: z.object({markdown: z.string()})});

// Model-chosen queries and URLs leave the platform, and results are untrusted reads (PRA-76).
export const WEB_TOOL_BOUNDARY: ToolClassification = {capabilities: ['read', 'external-egress'], decision: 'allow', untrustedSource: true};
export function webPageCacheKey(url: string): string {
  return WEB_CACHE_PREFIX + createHash('sha256').update(url).digest('hex');
}
function failure(code: 'policy-denied' | 'budget' | 'conflict' | 'upstream', message: string, remediation: string): never {
  throw new ToolBoundaryError({code, message, remediation});
}
type ProviderCall = (signal: AbortSignal, call: WebSpendCall, dispatch: WebDispatch) => Promise<unknown>;

export function webTools(ports: WebPorts | undefined, enabled = true): AgentTool[] {
  return [
    makeTool(WEB_TOOL_NAMES.search, WEB_TEXT.search, WebSearchInputSchema, async (args, context) => {
      const input = WebSearchInputSchema.parse(args);
      const raw = await paid('exa', exaSearchMaxMicroUsd(input.numResults), context, (signal, call, dispatch) => webRequest(ports!, 'exa', {
        query: input.query, type: 'auto', numResults: input.numResults, contents: {highlights: true},
        ...(input.includeDomains ? {includeDomains: input.includeDomains} : {}),
        ...(input.excludeDomains ? {excludeDomains: input.excludeDomains} : {}),
        ...(input.recency ? {startPublishedDate: input.recency} : {}),
      }, signal, call, dispatch));
      return {results: ExaResponse.parse(raw).results.slice(0, input.numResults).map(result => ({
        title: result.title ?? '', url: result.url, date: result.publishedDate ?? null,
        highlight: (result.highlights?.[0] ?? '').slice(0, LIMITS.HIGHLIGHT_CHARACTERS_MAX),
      }))};
    }),
    makeTool(WEB_TOOL_NAMES.read, WEB_TEXT.read, WebReadInputSchema, async (args, context) => {
      const {url} = WebReadInputSchema.parse(args);
      const target = await publicTarget(url, context.signal);
      const cacheable = !target.search;
      const key = webPageCacheKey(target.href);
      const cached = cacheable ? WebPageSchema.safeParse(await ports!.cache.get(key).catch(() => null)) : undefined;
      if (cached?.success && cached.data.url === target.href) return page(cached.data.markdown, target.href, context);
      const raw = await paid('firecrawl', FIRECRAWL_BASE_PAGE_CREDITS * FIRECRAWL_CREDIT_MICRO_USD, context, (signal, call, dispatch) => webRequest(ports!, 'firecrawl', {
        url: target.href, formats: ['markdown'], onlyMainContent: true, parsers: [], timeout: LIMITS.REQUEST_TIMEOUT_MS,
      }, signal, call, dispatch));
      const markdown = FirecrawlResponse.parse(raw).data.markdown;
      if (cacheable) await ports!.cache.set(key, {url: target.href, markdown}, LIMITS.CACHE_TTL_SECONDS).catch(() => {});
      return page(markdown, target.href, context);
    }),
  ];

  function makeTool(name: string, description: string, schema: z.ZodObject, execute: (args: JsonValue, context: ToolContext) => Promise<JsonObject>): AgentTool {
    return {
      spec: {type: 'tool.spec', name, description, inputSchema: z.toJSONSchema(schema) as JsonObject, source: {type: 'builtin'}, traits: ['readOnly', 'openWorld']},
      boundary: WEB_TOOL_BOUNDARY,
      async execute(args, context) {
        try {
          if (!enabled) failure('policy-denied', WEB_TEXT.disabled, WEB_TEXT.unavailableRemediation);
          if (!ports) failure('upstream', WEB_TEXT.unavailable, WEB_TEXT.unavailableRemediation);
          const value = await execute(args, context);
          return {isError: false, content: [{type: 'untrusted-data', ...value}]};
        } catch (error) {
          if (context.signal.aborted) throw error;
          const detail = error instanceof ToolBoundaryError ? error.detail : error instanceof z.ZodError
            ? {code: 'schema' as const, message: 'Invalid web tool arguments or provider response.', remediation: 'Match the tool schema or try another public page.'}
            : {code: 'upstream' as const, message: WEB_TEXT.unavailable, remediation: WEB_TEXT.readRemediation};
          return {isError: true, error: detail, content: [{type: 'text', text: JSON.stringify(detail)}]};
        }
      },
    };
  }
  async function publicTarget(url: string, signal: AbortSignal): Promise<URL> {
    try {
      const target = await ports!.assertPublicUrl(url);
      target.hash = '';
      const check = await ports!.egress(target, {method: 'HEAD', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)])});
      await check.body?.cancel();
      return target;
    } catch {
      return failure('policy-denied', WEB_TEXT.unsafe, WEB_TEXT.unsafeRemediation);
    }
  }
  async function page(markdown: string, url: string, context: ToolContext): Promise<JsonObject> {
    const truncated = markdown.length > LIMITS.PAGE_CHARACTERS_MAX;
    const outputRef = truncated ? await ports!.spill({userId: context.userId, runId: context.runId, callId: context.callId, text: markdown}) : undefined;
    return {url, markdown: markdown.slice(0, LIMITS.PAGE_CHARACTERS_MAX), truncated, ...(outputRef ? {outputRef} : {})};
  }
  /** Settles a billed dispatch before any downstream processing; releases only calls that provably never billed. */
  async function paid(service: WebSpendCall['service'], estimateMicroUsd: number, context: ToolContext, request: ProviderCall): Promise<unknown> {
    const call = {userId: context.userId, runId: context.runId, callId: context.callId, service, estimateMicroUsd};
    const admission = await ports!.accounting.reserve(call);
    if (admission === 'denied') failure('budget', WEB_TEXT.budget, WEB_TEXT.budgetRemediation);
    if (admission === 'duplicate') failure('conflict', WEB_TEXT.duplicate, WEB_TEXT.duplicateRemediation);
    const dispatch = newDispatch();
    let raw: unknown;
    try {
      context.signal.throwIfAborted();
      raw = await request(AbortSignal.any([context.signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)]), call, dispatch);
    } catch (error) {
      if (dispatch.billed) await ports!.accounting.settle({...call, actualMicroUsd: estimateMicroUsd, slot: dispatch.slot});
      else if (!dispatch.uncertain) await ports!.accounting.release(call);
      throw error;
    }
    await ports!.accounting.settle({...call, actualMicroUsd: estimateMicroUsd, slot: dispatch.slot});
    return raw;
  }
}
