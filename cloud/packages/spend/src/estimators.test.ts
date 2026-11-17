import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {exaContentsMaxMicroUsd, exaSearchMaxMicroUsd, firecrawlMaxMicroUsd} from './estimators.js';

// Independent price-sheet fixtures prevent a lowered implementation constant from weakening the bound.
const EXA_PUBLISHED_PRICES = [
  {type: 'auto', baseMicroUsd: 7_000},
  {type: 'fast', baseMicroUsd: 7_000},
  {type: 'lite', baseMicroUsd: 4_000},
  {type: 'instant', baseMicroUsd: 4_000},
  {type: 'deep-lite', baseMicroUsd: 12_000},
  {type: 'deep', baseMicroUsd: 12_000},
  {type: 'deep-reasoning', baseMicroUsd: 15_000},
] as const;
const RESULTS_MAX = 1_000;
const PAGES_MAX = 10_000;
const RUNS = 1_000;

describe('PRA-103 published worst-case bounds (2026-11-17)', () => {
  it('reserves deep-family pricing and summaries on included and extra results', () => {
    expect(exaSearchMaxMicroUsd(10, {type: 'deep'})).toBe(15_000);
    expect(exaSearchMaxMicroUsd(25, {type: 'deep', summaries: true})).toBe(55_000);
    expect(exaSearchMaxMicroUsd(10, {summaries: true})).toBe(17_000);
    expect(exaContentsMaxMicroUsd(3, 2)).toBe(6_000);
  });

  it('always covers published Exa bases, extra results and page summaries', () => {
    fc.assert(fc.property(
      fc.integer({min: 0, max: RESULTS_MAX}), fc.boolean(),
      (results, summaries) => {
        for (const price of EXA_PUBLISHED_PRICES) {
          const published = price.baseMicroUsd + Math.max(0, results - 10) * 1_000
            + (summaries ? results * 1_000 : 0);
          expect(exaSearchMaxMicroUsd(results, {type: price.type, summaries})).toBeGreaterThanOrEqual(published);
        }
      },
    ), {numRuns: RUNS});
  });

  it('reserves all stacked Firecrawl options, threat scans and PII on additional PDF pages', () => {
    expect(firecrawlMaxMicroUsd(1)).toBe(180_000);
    expect(firecrawlMaxMicroUsd(1, 3)).toBe(255_000);
    expect(firecrawlMaxMicroUsd(0)).toBe(0);
  });

  it('always covers published Firecrawl option combinations and every self-serve credit rate', () => {
    fc.assert(fc.property(
      fc.integer({min: 0, max: PAGES_MAX}), fc.integer({min: 0, max: PAGES_MAX}),
      fc.record({
        json: fc.boolean(), questionOrQuery: fc.boolean(), highlights: fc.boolean(),
        pii: fc.boolean(), injection: fc.boolean(), audio: fc.boolean(), video: fc.boolean(),
        lockdown: fc.boolean(), zdr: fc.boolean(), threat: fc.boolean(),
      }),
      (pages, pdfPages, options) => {
        const modifiers = [options.json, options.questionOrQuery, options.highlights,
          options.pii, options.injection, options.audio, options.video, options.lockdown];
        const creditsPerPage = 1 + modifiers.filter(Boolean).length * 4
          + Number(options.zdr) + Number(options.threat) * 2;
        const credits = pages * creditsPerPage + pdfPages * (options.pii ? 5 : 1);
        for (const creditMicroUsd of [5_000, 3_800, 2_500, 2_000, 1_000]) {
          expect(firecrawlMaxMicroUsd(pages, pdfPages)).toBeGreaterThanOrEqual(credits * creditMicroUsd);
        }
      },
    ), {numRuns: RUNS});
  });
});
