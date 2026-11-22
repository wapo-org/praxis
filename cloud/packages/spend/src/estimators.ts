/** Worst-case list prices checked 2026-11-17; PRA-102 owns the allowance, not these unit estimates. */

/** Auto/fast base covers ten results: https://exa.ai/docs/admin/pricing */
export const EXA_SEARCH_MICRO_USD = 7_000;
/** The base request includes ten results: https://exa.ai/docs/admin/pricing */
export const EXA_SEARCH_INCLUDED_RESULTS = 10;
/** Deep-family ceiling includes legacy deep-reasoning: https://exa.ai/docs/admin/pricing */
export const EXA_DEEP_SEARCH_MICRO_USD = 15_000;
/** Extra results bill beyond the included ten: https://exa.ai/docs/admin/pricing */
export const EXA_EXTRA_RESULT_MICRO_USD = 1_000;
/** Summaries bill for every returned page: https://exa.ai/docs/admin/pricing */
export const EXA_SUMMARY_PAGE_MICRO_USD = 1_000;
/** Contents bill per page per content type: https://exa.ai/docs/admin/pricing */
export const EXA_CONTENTS_PAGE_MICRO_USD = 1_000;

/** Hobby PAYG is the dearest credit ($5/1,000): https://docs.firecrawl.dev/billing */
export const FIRECRAWL_CREDIT_MICRO_USD = 5_000;
/** Celeris Decision input rate: $0.004 per million tokens, per PRA-179 pricing review. */
export const CELERIS_DECISION_INPUT_MICRO_USD_PER_MILLION_TOKENS = 4_000;
/** Keeps a dispatched platform call chargeable when usage is below one micro-USD. */
export const PLATFORM_CALL_MINIMUM_MICRO_USD = 1;
/** Every regular scrape starts at one credit: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_BASE_PAGE_CREDITS = 1;
/** JSON, question/query, highlights, PII, injection, audio, video and lockdown each stack: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_OPTION_PAGE_CREDITS = 4;
/** Eight independently billed four-credit modifiers form the ceiling: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_OPTIONS_MAX = 8;
/** ZDR stacks with formats and security options: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_ZDR_PAGE_CREDITS = 1;
/** Threat scans can bill even for blocked URLs: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_THREAT_SCAN_URL_CREDITS = 2;
/** All regular scrape modifiers are reserved, even if fewer are enabled: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_PAGE_CREDITS_MAX = FIRECRAWL_BASE_PAGE_CREDITS
  + FIRECRAWL_OPTIONS_MAX * FIRECRAWL_OPTION_PAGE_CREDITS
  + FIRECRAWL_ZDR_PAGE_CREDITS + FIRECRAWL_THREAT_SCAN_URL_CREDITS;
/** PDF parsing adds one credit per additional page: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_PDF_PAGE_CREDITS = 1;
/** PII also bills on each additional PDF page: https://docs.firecrawl.dev/billing */
export const FIRECRAWL_PDF_PAGE_CREDITS_MAX = FIRECRAWL_PDF_PAGE_CREDITS + FIRECRAWL_OPTION_PAGE_CREDITS;

/** Non-preemptible sandbox core-second rate: https://modal.com/pricing */
export const MODAL_CORE_SECOND_MICRO_USD = 39.42;
/** Conservative non-preemptible GiB-second rate: https://modal.com/pricing */
export const MODAL_GIB_SECOND_MICRO_USD = 6.72;
/** PRA-19 defaults: 1 core, 2 GiB; treated as 1 physical core, the dearer reading. */
export const MODAL_DEFAULT_CORES = 1;
export const MODAL_DEFAULT_MEMORY_GIB = 2;
export const SECONDS_PER_MINUTE = 60;
export const MS_PER_SECOND = 1_000;

function wholeMicroUsd(value: number): number {
  return Math.ceil(value - 1e-9);
}

export interface ExaSearchOptions {
  type?: 'auto' | 'fast' | 'lite' | 'instant' | 'deep' | 'deep-lite' | 'deep-reasoning';
  summaries?: boolean;
}

export function exaSearchMaxMicroUsd(results: number, options: ExaSearchOptions = {}): number {
  const extra = Math.max(0, results - EXA_SEARCH_INCLUDED_RESULTS);
  const deep = options.type === 'deep' || options.type === 'deep-lite' || options.type === 'deep-reasoning';
  const base = deep ? EXA_DEEP_SEARCH_MICRO_USD : EXA_SEARCH_MICRO_USD;
  const summaries = options.summaries ? results * EXA_SUMMARY_PAGE_MICRO_USD : 0;
  return base + extra * EXA_EXTRA_RESULT_MICRO_USD + summaries;
}

export function exaContentsMaxMicroUsd(pages: number, contentTypes = 1): number {
  return pages * contentTypes * EXA_CONTENTS_PAGE_MICRO_USD;
}

/** Bounds regular scrape/crawl with capped URL and additional PDF pages; excludes provider-routed URLs and v1 agent usage. */
export function firecrawlMaxMicroUsd(pages: number, pdfPages = 0): number {
  return (pages * FIRECRAWL_PAGE_CREDITS_MAX + pdfPages * FIRECRAWL_PDF_PAGE_CREDITS_MAX) * FIRECRAWL_CREDIT_MICRO_USD;
}

export function modalSandboxSecondMicroUsd(cores = MODAL_DEFAULT_CORES, memoryGiB = MODAL_DEFAULT_MEMORY_GIB): number {
  return cores * MODAL_CORE_SECOND_MICRO_USD + memoryGiB * MODAL_GIB_SECOND_MICRO_USD;
}

/** Reserve sandbox time by the sandbox's own timeout, which Modal enforces, so the actual cost cannot exceed it. */
export function modalSandboxMaxMicroUsd(minutes: number, cores = MODAL_DEFAULT_CORES, memoryGiB = MODAL_DEFAULT_MEMORY_GIB): number {
  return wholeMicroUsd(minutes * SECONDS_PER_MINUTE * modalSandboxSecondMicroUsd(cores, memoryGiB));
}

/** Prices a span of sandbox time, rounded up to whole seconds and whole micro-USD so it never undercounts. */
export function modalSandboxMicroUsd(durationMs: number, cores = MODAL_DEFAULT_CORES, memoryGiB = MODAL_DEFAULT_MEMORY_GIB): number {
  const seconds = Math.ceil(Math.max(0, durationMs) / MS_PER_SECOND);
  return seconds === 0 ? 0 : wholeMicroUsd(seconds * modalSandboxSecondMicroUsd(cores, memoryGiB));
}

/** The longest whole-second span that `budgetMicroUsd` pays for, so its price never exceeds the budget. */
export function modalSandboxAffordableMs(budgetMicroUsd: number, cores = MODAL_DEFAULT_CORES, memoryGiB = MODAL_DEFAULT_MEMORY_GIB): number {
  const seconds = Math.floor(Math.max(0, budgetMicroUsd) / modalSandboxSecondMicroUsd(cores, memoryGiB) + 1e-9);
  return seconds * MS_PER_SECOND;
}

/** Converts the provider's billed amount, in dollars, to whole micro-USD rounded up, so settlement never undercounts. */
export function microUsdFromUsd(usd: number): number {
  return wholeMicroUsd(usd * 1_000_000);
}

export function celerisDecisionMaxMicroUsd(inputTokens: number): number {
  return Math.max(PLATFORM_CALL_MINIMUM_MICRO_USD, wholeMicroUsd(inputTokens * CELERIS_DECISION_INPUT_MICRO_USD_PER_MILLION_TOKENS / 1_000_000));
}
