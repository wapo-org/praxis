/**
 * The liquid-glass material: tier negotiation, the per-material ramp and the
 * base-chroma probe. Ported from wapo.dp `src/lib/glass/engine-detect.ts` and
 * `glass-store.ts` (kube.io constants), tuned for this app's warm paper.
 *
 * Tiers:
 *  - `svg`   Chromium engines: `backdrop-filter: url(#id)`, the kube.io lens.
 *  - `frost` Safari, Firefox and anything else: three stacked, masked
 *            backdrop-blur bands. Never gated on CSS.supports(url()): that tests
 *            parsing, not rendering, and is true on engines that do not render it.
 *
 * The source's shader tier and DOM capture are deliberately not ported: that was the original lag.
 */
import { useSyncExternalStore } from 'react';

export type GlassMaterial = 'regular' | 'thick' | 'clear';
export type GlassTier = 'svg' | 'frost';

/** kube.io's shipped maxDisplacement constants, verbatim. */
export const MAX_DISPLACEMENT = {
  thin: 78.53293977771185,
  magnifier: 122.80891678834695,
  hero: 133.9733637691058,
} as const;

export interface MaterialRampEntry {
  /** The rest scale ratio is refraction × 0.8; held it rises to × 1.0. */
  refraction: number;
  maxDisplacement: number;
  /** Bezel band width in px, clamped to the corner radius by the map renderer. */
  bezel: number;
  /** Core frost, feGaussianBlur stdDeviation inside the lens chain. */
  blur: number;
  /** Extra stdDeviation of the rim frost band, composited through the frost mask. */
  rimBlur: number;
  /** feColorMatrix saturate on the refracted rim (composited through the specular map). */
  saturate: number;
  specularOpacity: number;
  /** Progressive frost radii for the non-Chromium tier: core, mid, rim (px). */
  frost: readonly [number, number, number];
  /** Saturate on the frost tier's rim band only. */
  frostSaturate: number;
  /** Pull budget multiplier against STRETCH_BUDGET. */
  stretch: number;
  /** Release overshoot, framer's spring `bounce`. Thicker glass wobbles less. */
  bounce: number;
  /** Release settle time in seconds. */
  settle: number;
}

export const MATERIAL_RAMP: Record<GlassMaterial, MaterialRampEntry> = {
  clear: {
    refraction: 0.875,
    maxDisplacement: MAX_DISPLACEMENT.thin,
    bezel: 21,
    blur: 0.8,
    rimBlur: 1,
    saturate: 4,
    specularOpacity: 0.25,
    frost: [1, 3, 7],
    frostSaturate: 1.5,
    stretch: 0.85,
    bounce: 0.5,
    settle: 0.68,
  },
  regular: {
    refraction: 1,
    maxDisplacement: MAX_DISPLACEMENT.magnifier,
    bezel: 20,
    blur: 3,
    rimBlur: 1.5,
    saturate: 6,
    specularOpacity: 0.5,
    frost: [6, 10, 16],
    frostSaturate: 1.5,
    stretch: 1,
    bounce: 0.48,
    settle: 0.74,
  },
  thick: {
    refraction: 1.25,
    maxDisplacement: MAX_DISPLACEMENT.hero,
    bezel: 32.5,
    blur: 9,
    rimBlur: 2,
    saturate: 4,
    specularOpacity: 0.4,
    frost: [14, 18, 24],
    frostSaturate: 1.5,
    stretch: 1.3,
    bounce: 0.42,
    settle: 0.88,
  },
};

/** At most ~1 cm (37.8 px at 96 dpi) or 22% of the pulled axis, scaled per material. */
export const STRETCH_BUDGET = { cmPx: 37.8, fraction: 0.22 } as const;

/** feDisplacementMap scale at rest (ratio × 0.8) or held (× 1.0). */
export function lensScale(material: GlassMaterial, held: boolean): number {
  const ramp = MATERIAL_RAMP[material];
  return ramp.maxDisplacement * ramp.refraction * (held ? 1 : 0.8);
}

export function isChromiumEngine(nav: { userAgent: string; userAgentData?: { brands?: Array<{ brand: string }> } }): boolean {
  const brands = nav.userAgentData?.brands;
  if (brands?.some((b) => b.brand === 'Chromium' || b.brand === 'Google Chrome')) return true;
  // Every Chromium browser, on every OS except iOS, advertises Chrome/ with no Firefox token.
  return /\b(Chrome|Chromium|HeadlessChrome)\//.test(nav.userAgent) && !/Firefox|FxiOS|CriOS/.test(nav.userAgent);
}

let tier: GlassTier | null = null;

/** Negotiated once per page. Fail direction: frost, which renders everywhere. */
export function glassTier(): GlassTier {
  if (tier) return tier;
  if (typeof navigator === 'undefined') return 'frost';
  tier = isChromiumEngine(navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    ? 'svg'
    : 'frost';
  return tier;
}

/* ---------------------- base-background chroma ---------------------- */

export interface BaseChroma {
  or: number;
  og: number;
  ob: number;
}

const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

/**
 * Backdrop-filter samples the page canvas, and the saturate node would
 * multiply its colour (warm paper turns the rim yellow), so the chain opens by
 * moving the base colour onto its own luma. Surrounding material still tints
 * the glass; the page's own background cannot. Null when already neutral.
 */
export function chromaOffsets(rgb: readonly [number, number, number] | null): BaseChroma | null {
  if (!rgb) return null;
  const [r, g, b] = rgb;
  if (Math.abs(r - g) < 0.5 && Math.abs(g - b) < 0.5 && Math.abs(r - b) < 0.5) return null;
  const luma = LUMA.r * r + LUMA.g * g + LUMA.b * b;
  return { or: (luma - r) / 255, og: (luma - g) / 255, ob: (luma - b) / 255 };
}

function readBase(): readonly [number, number, number] | null {
  const hit = getComputedStyle(document.body ?? document.documentElement).backgroundColor.match(
    /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/,
  );
  return hit ? [Number(hit[1]), Number(hit[2]), Number(hit[3])] : null;
}

let chroma: BaseChroma | null = null;
const listeners = new Set<() => void>();
let probe: MutationObserver | null = null;

function read() {
  const next = chromaOffsets(readBase());
  if (next?.or === chroma?.or && next?.og === chroma?.og && next?.ob === chroma?.ob) return;
  chroma = next;
  listeners.forEach((listener) => listener());
}

function subscribeChroma(listener: () => void) {
  listeners.add(listener);
  if (!probe) {
    probe = new MutationObserver(read);
    probe.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    read();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      probe?.disconnect();
      probe = null;
    }
  };
}

/** One probe per document; re-reads on theme change. */
export function useBaseChroma(): BaseChroma | null {
  return useSyncExternalStore(subscribeChroma, () => chroma, () => null);
}
