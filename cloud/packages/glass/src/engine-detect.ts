/**
 * Engine capability detection & Liquid Glass material ramp (ported from wapo.dp).
 */

export type GlassStrategy = 'svg-displacement' | 'progressive-frost' | 'reduced-transparency';
export type MaterialLevel = 'ultrathin' | 'thin' | 'regular' | 'thick';
export type GlassShape = 'capsule' | 'card' | 'free';
export type RefractionIntensity = 'subtle' | 'medium' | 'strong';

export interface GlassFinish {
  tint?: number;
  sheen?: number;
  rim?: number;
  border?: number;
  inner?: number;
  shadow?: number;
}

export interface ResolvedFinish {
  tint: number;
  sheen: number;
  rim: number;
  border: number;
  inner: number;
  shadow: number;
}

export const FINISH_DEFAULTS: ResolvedFinish = {
  tint: 1,
  sheen: 1,
  rim: 1,
  border: 1,
  inner: 1,
  shadow: 1,
};

export interface MaterialSpec {
  bezel: number;
  maxDisplacement: number;
  refraction: number;
  frostCore: number;
  frostMid: number;
  frostRim: number;
  saturate: number;
  specularOpacity: number;
  tintLight: string;
  tintDark: string;
  stretch: number;
}

export const MATERIAL_RAMP: Record<MaterialLevel, MaterialSpec> = {
  ultrathin: {
    bezel: 4,
    maxDisplacement: 55.65,
    refraction: 0.42,
    frostCore: 2,
    frostMid: 5,
    frostRim: 10,
    saturate: 135,
    specularOpacity: 0.34,
    tintLight: 'rgba(251, 251, 249, 0.56)',
    tintDark: 'rgba(21, 21, 19, 0.58)',
    stretch: 0.04,
  },
  thin: {
    bezel: 21,
    maxDisplacement: 78.53,
    refraction: 0.58,
    frostCore: 4,
    frostMid: 9,
    frostRim: 16,
    saturate: 150,
    specularOpacity: 0.44,
    tintLight: 'rgba(251, 251, 249, 0.66)',
    tintDark: 'rgba(21, 21, 19, 0.68)',
    stretch: 0.055,
  },
  regular: {
    bezel: 20,
    maxDisplacement: 122.81,
    refraction: 0.72,
    frostCore: 8,
    frostMid: 14,
    frostRim: 22,
    saturate: 165,
    specularOpacity: 0.52,
    tintLight: 'rgba(251, 251, 249, 0.74)',
    tintDark: 'rgba(21, 21, 19, 0.76)',
    stretch: 0.07,
  },
  thick: {
    bezel: 32.5,
    maxDisplacement: 133.97,
    refraction: 0.86,
    frostCore: 14,
    frostMid: 22,
    frostRim: 32,
    saturate: 180,
    specularOpacity: 0.62,
    tintLight: 'rgba(251, 251, 249, 0.84)',
    tintDark: 'rgba(21, 21, 19, 0.86)',
    stretch: 0.085,
  },
};

export const SHAPE_RADIUS: Record<GlassShape, number> = {
  capsule: 9999,
  card: 20,
  free: 22,
};

export const INTENSITY_BASE_SCALE: Record<RefractionIntensity, number> = {
  subtle: 0.6,
  medium: 1.0,
  strong: 1.35,
};

export const STRETCH_BUDGET = {
  maxOffsetPx: 48,
  maxScaleDelta: 0.055,
};

export function prefersReducedTransparency(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Negotiates the highest-fidelity liquid glass strategy supported by the user's browser engine:
 * - Chromium (Chrome / Edge / Arc / Brave): 'svg-displacement' (real-time SVG feDisplacementMap + specular rim)
 * - WebKit (Safari macOS / iOS) & Gecko (Firefox): 'progressive-frost' (3-band radial progressive backdrop-filter + specular sheen + dual 1px inset rim lighting)
 * - Reduced transparency preference: 'reduced-transparency' (high-contrast opaque Paper.card / Paper.fill1)
 */
export function negotiateStrategy(): GlassStrategy {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'progressive-frost';
  }
  if (prefersReducedTransparency()) {
    return 'reduced-transparency';
  }
  const ua = navigator.userAgent || '';
  const isChromium =
    /Chrome\/|Chromium\/|Edg\//.test(ua) &&
    !/Safari\/.*Version\//.test(ua) &&
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('backdrop-filter', 'blur(4px)');

  if (isChromium) {
    return 'svg-displacement';
  }
  return 'progressive-frost';
}
