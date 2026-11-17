/** Worst-case platform prices in micro-USD (list prices checked 2026-11-17; PRA-102 owns the review), rounded up. */

/** Exa search with contents: $7 per 1,000 requests, covering up to 10 results. */
export const EXA_SEARCH_MICRO_USD = 7_000;
export const EXA_SEARCH_INCLUDED_RESULTS = 10;
/** Exa: $1 per 1,000 extra results beyond the included 10. */
export const EXA_EXTRA_RESULT_MICRO_USD = 1_000;
/** Exa contents endpoint: $1 per 1,000 pages per content type. */
export const EXA_CONTENTS_PAGE_MICRO_USD = 1_000;

/** Firecrawl's dearest credit: Hobby, $19 for 3,000 credits. */
export const FIRECRAWL_CREDIT_MICRO_USD = 6_334;
/** Scrape/crawl 1 credit plus 4 for the JSON/question/highlight formats: the per-page ceiling. */
export const FIRECRAWL_PAGE_CREDITS_MAX = 5;
/** PDF parsing adds 1 credit per PDF page. */
export const FIRECRAWL_PDF_PAGE_CREDITS = 1;

/** Modal sandbox (non-preemptible) CPU: $0.00003942 per physical core-second. */
export const MODAL_CORE_SECOND_MICRO_USD = 39.42;
/** Modal sandbox memory, higher of the published figures: $0.00000672 per GiB-second. */
export const MODAL_GIB_SECOND_MICRO_USD = 6.72;
/** PRA-19 defaults: 1 core, 2 GiB; treated as 1 physical core, the dearer reading. */
export const MODAL_DEFAULT_CORES = 1;
export const MODAL_DEFAULT_MEMORY_GIB = 2;
export const SECONDS_PER_MINUTE = 60;

function wholeMicroUsd(value: number): number {
  return Math.ceil(value - 1e-9);
}

export function exaSearchMaxMicroUsd(results: number): number {
  const extra = Math.max(0, results - EXA_SEARCH_INCLUDED_RESULTS);
  return EXA_SEARCH_MICRO_USD + extra * EXA_EXTRA_RESULT_MICRO_USD;
}

export function exaContentsMaxMicroUsd(pages: number, contentTypes = 1): number {
  return pages * contentTypes * EXA_CONTENTS_PAGE_MICRO_USD;
}

/** Reserve a crawl by its page limit: the caller passes the same limit to Firecrawl, so it cannot bill more pages. */
export function firecrawlMaxMicroUsd(pages: number, pdfPages = 0): number {
  return (pages * FIRECRAWL_PAGE_CREDITS_MAX + pdfPages * FIRECRAWL_PDF_PAGE_CREDITS) * FIRECRAWL_CREDIT_MICRO_USD;
}

/** Reserve sandbox time by the sandbox's own timeout, which Modal enforces, so the actual cost cannot exceed it. */
export function modalSandboxMaxMicroUsd(minutes: number, cores = MODAL_DEFAULT_CORES, memoryGiB = MODAL_DEFAULT_MEMORY_GIB): number {
  const perSecond = cores * MODAL_CORE_SECOND_MICRO_USD + memoryGiB * MODAL_GIB_SECOND_MICRO_USD;
  return wholeMicroUsd(minutes * SECONDS_PER_MINUTE * perSecond);
}

/** Converts the provider's billed amount, in dollars, to whole micro-USD rounded up, so settlement never undercounts. */
export function microUsdFromUsd(usd: number): number {
  return wholeMicroUsd(usd * 1_000_000);
}
