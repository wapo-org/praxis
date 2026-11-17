import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ToolBoundaryError, type AgentTool, type ToolClassifier, type ToolContext} from '@praxis/agent';
import {exaSearchMaxMicroUsd, FIRECRAWL_BASE_PAGE_CREDITS, FIRECRAWL_CREDIT_MICRO_USD} from '@praxis/spend';
import {WEB_TOOL_LIMITS as LIMITS, WEB_TOOL_NAMES, WebPageSchema, WebReadInputSchema, WebSearchInputSchema, type JsonObject, type JsonValue} from '@praxis/protocol';
import {WEB_CACHE_PREFIX, WEB_TEXT, WEB_OUTPUT_READ_TOOL} from './constants.js';
import type {WebPorts, WebSpendInput} from './ports.js';
import {webRequest} from './provider.js';

const ExaResponse = z.object({results: z.array(z.object({
  title: z.string().nullable().optional(), url: z.url(), publishedDate: z.string().optional(),
  highlights: z.array(z.string()).optional(),
})).max(LIMITS.SEARCH_RESULTS_MAX)});
const FirecrawlResponse = z.object({success: z.literal(true), data: z.object({markdown: z.string()})});

export const webToolClassifier: ToolClassifier = {
  classify: call => Object.values(WEB_TOOL_NAMES).some(name => name === call.tool)
    ? {capabilities: ['read', 'external-egress'], decision: 'allow', untrustedSource: true}
    : call.tool === WEB_OUTPUT_READ_TOOL ? {capabilities: ['read'], decision: 'allow', untrustedSource: true} : undefined,
};
export function webPageCacheKey(url: string): string {
  return WEB_CACHE_PREFIX + createHash('sha256').update(url).digest('hex');
}
function failure(code: 'policy-denied' | 'budget' | 'conflict' | 'upstream', message: string, remediation: string): never {
  throw new ToolBoundaryError({code, message, remediation});
}

export function webTools(ports: WebPorts | undefined, enabled = true): AgentTool[] {
  return [
    makeTool(WEB_TOOL_NAMES.search, WEB_TEXT.search, WebSearchInputSchema, async (args, context) => {
      const input = WebSearchInputSchema.parse(args);
      return paid('exa', exaSearchMaxMicroUsd(input.numResults), context, async (signal, spend) => {
        const response = await webRequest(ports!, 'exa', {
          query: input.query, type: 'auto', numResults: input.numResults, contents: {highlights: true},
          ...(input.includeDomains ? {includeDomains: input.includeDomains} : {}),
          ...(input.excludeDomains ? {excludeDomains: input.excludeDomains} : {}),
          ...(input.recency ? {startPublishedDate: input.recency} : {}),
        }, signal, spend);
        const parsed = ExaResponse.parse(response.value);
        return {slot: response.slot, value: {results: parsed.results.slice(0, input.numResults).map(result => ({
          title: result.title ?? '', url: result.url, date: result.publishedDate ?? null,
          highlight: (result.highlights?.[0] ?? '').slice(0, LIMITS.HIGHLIGHT_CHARACTERS_MAX),
        }))}};
      });
    }),
    makeTool(WEB_TOOL_NAMES.read, WEB_TEXT.read, WebReadInputSchema, async (args, context) => {
      const {url} = WebReadInputSchema.parse(args);
      let target: URL;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)]);
      try {
        target = await ports!.assertPublicUrl(url);
        target.hash = '';
        const check = await ports!.egress(target, {method: 'HEAD', redirect: 'error', signal});
        await check.body?.cancel();
      } catch {
        return failure('policy-denied', WEB_TEXT.unsafe, WEB_TEXT.unsafeRemediation);
      }
      const cacheable = !target.search;
      const key = webPageCacheKey(target.href);
      return paid('firecrawl', FIRECRAWL_BASE_PAGE_CREDITS * FIRECRAWL_CREDIT_MICRO_USD, context, async (requestSignal, spend) => {
        const cached = cacheable ? WebPageSchema.safeParse(await ports!.cache.get(key).catch(() => null)) : undefined;
        if (cached?.success && cached.data.url === target.href) return {slot: 0, actualMicroUsd: 0, value: await page(cached.data.markdown, target.href, context)};
        const response = await webRequest(ports!, 'firecrawl', {
          url: target.href, formats: ['markdown'], onlyMainContent: true, parsers: [],
          timeout: LIMITS.REQUEST_TIMEOUT_MS,
        }, requestSignal, spend);
        const markdown = FirecrawlResponse.parse(response.value).data.markdown;
        if (cacheable) await ports!.cache.set(key, {url: target.href, markdown}, LIMITS.CACHE_TTL_SECONDS).catch(() => {});
        return {slot: response.slot, value: await page(markdown, target.href, context)};
      });
    }),
  ];

  function makeTool(name: string, description: string, schema: z.ZodObject, execute: (args: JsonValue, context: ToolContext) => Promise<JsonObject>): AgentTool {
    return {
      spec: {type: 'tool.spec', name, description, inputSchema: z.toJSONSchema(schema) as JsonObject, source: {type: 'builtin'}, traits: ['readOnly', 'openWorld']},
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
  async function page(markdown: string, url: string, context: ToolContext): Promise<JsonObject> {
    const truncated = markdown.length > LIMITS.PAGE_CHARACTERS_MAX;
    const outputRef = truncated ? await ports!.spill({userId: context.userId, runId: context.runId, callId: context.callId, text: markdown}) : undefined;
    return {url, markdown: markdown.slice(0, LIMITS.PAGE_CHARACTERS_MAX), truncated, ...(outputRef ? {outputRef} : {})};
  }
  async function paid(service: WebSpendInput['service'], estimateMicroUsd: number, context: ToolContext,
    execute: (signal: AbortSignal, input: WebSpendInput) => Promise<{slot: number; value: JsonObject; actualMicroUsd?: number}>): Promise<JsonObject> {
    const input = {userId: context.userId, runId: context.runId, callId: context.callId, service, estimateMicroUsd};
    const admission = await ports!.accounting.reserve(input);
    if (admission === 'denied') failure('budget', WEB_TEXT.budget, WEB_TEXT.budgetRemediation);
    if (admission === 'duplicate') failure('conflict', WEB_TEXT.duplicate, WEB_TEXT.duplicateRemediation);
    let response;
    try {
      context.signal.throwIfAborted();
      response = await execute(AbortSignal.any([context.signal, AbortSignal.timeout(LIMITS.REQUEST_TIMEOUT_MS)]), input);
    } catch (error) {
      await ports!.accounting.release(input);
      throw error;
    }
    await ports!.accounting.settle({...input, actualMicroUsd: response.actualMicroUsd ?? estimateMicroUsd, slot: response.slot, payer: 'platform'});
    return response.value;
  }
}
