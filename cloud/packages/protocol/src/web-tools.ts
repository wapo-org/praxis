import {z} from 'zod';

export const WEB_TOOL_LIMITS = {
  SEARCHES_PER_HOUR_MAX: 30, READS_PER_HOUR_MAX: 60, HOUR_MS: 3_600_000,
  SEARCH_RESULTS_DEFAULT: 8, SEARCH_RESULTS_MAX: 10, QUERY_CHARACTERS_MAX: 2_000,
  DOMAINS_MAX: 20, URL_CHARACTERS_MAX: 8_192, PAGE_CHARACTERS_MAX: 24_000,
  HIGHLIGHT_CHARACTERS_MAX: 1_000, RESPONSE_BYTES_MAX: 4_000_000,
  REQUEST_TIMEOUT_MS: 60_000, CACHE_TTL_SECONDS: 900,
  EXA_SEARCHES_PER_SECOND_MAX: 8, FIRECRAWL_READS_PER_MINUTE_MAX: 80,
  FIRECRAWL_IN_FLIGHT_MAX: 5,
} as const;
export const WEB_TOOL_NAMES = {search: 'web_search', read: 'web_read'} as const;
const Domain = z.string().max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/);
export const WebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(WEB_TOOL_LIMITS.QUERY_CHARACTERS_MAX),
  numResults: z.number().int().min(1).max(WEB_TOOL_LIMITS.SEARCH_RESULTS_MAX).default(WEB_TOOL_LIMITS.SEARCH_RESULTS_DEFAULT),
  includeDomains: z.array(Domain).max(WEB_TOOL_LIMITS.DOMAINS_MAX).optional(),
  excludeDomains: z.array(Domain).max(WEB_TOOL_LIMITS.DOMAINS_MAX).optional(),
  recency: z.iso.datetime({offset: true}).optional(),
}).strict();
export const WebReadInputSchema = z.object({url: z.url().max(WEB_TOOL_LIMITS.URL_CHARACTERS_MAX)}).strict();
export const WebPageSchema = z.object({url: z.url(), markdown: z.string().max(WEB_TOOL_LIMITS.RESPONSE_BYTES_MAX)}).strict();
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;
export const WEB_OUTPUT_CHUNK_CHARACTERS_MAX = 100_000;
export const WebOutputManifestSchema = z.object({
  chunkIds: z.array(z.string()).max(Math.ceil(WEB_TOOL_LIMITS.RESPONSE_BYTES_MAX / WEB_OUTPUT_CHUNK_CHARACTERS_MAX)),
  characters: z.number().int().nonnegative().max(WEB_TOOL_LIMITS.RESPONSE_BYTES_MAX),
});

// Accounting RPC between the API and Convex; one definition so both boundaries parse the same shape.
const MicroUsd = z.number().int().nonnegative();
export const WEB_SPEND_PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
export const WebSpendServiceSchema = z.enum(['exa', 'firecrawl']);
export const WebSpendCallSchema = z.object({
  userId: z.string().min(1), runId: z.string().min(1), callId: z.string().min(1),
  service: WebSpendServiceSchema, estimateMicroUsd: MicroUsd,
}).strict();
const WebSpendChargeFields = {actualMicroUsd: MicroUsd, slot: z.number().int().nonnegative()};
export const WebSpendChargeSchema = WebSpendCallSchema.extend(WebSpendChargeFields);
export const WebSpendRequestSchema = WebSpendCallSchema.extend({period: z.string().regex(WEB_SPEND_PERIOD_PATTERN)});
export const WebSpendSettlementSchema = WebSpendRequestSchema.extend(WebSpendChargeFields);
export const WebSpendAdmissionSchema = z.enum(['reserved', 'denied', 'duplicate']);
export type WebSpendCall = z.infer<typeof WebSpendCallSchema>;
export type WebSpendCharge = z.infer<typeof WebSpendChargeSchema>;
export type WebSpendRequest = z.infer<typeof WebSpendRequestSchema>;
export type WebSpendSettlement = z.infer<typeof WebSpendSettlementSchema>;
export type WebSpendAdmission = z.infer<typeof WebSpendAdmissionSchema>;
