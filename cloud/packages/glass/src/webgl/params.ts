// Ported from wapo.dp/src/lib/glass/webgl-refraction.ts (archisvaze/liquid-glass).
import type { MaterialLevel } from '../engine-detect';
export interface RefractionParams {
  /** glass thickness in px — reference slider 10..200, default 50 */
  thickness: number;
  /** bezel band width in px — reference slider 2..60, default 60 */
  bezel: number;
  /** index of refraction — reference slider 1..3, default 3 */
  ior: number;
  /** in-glass backdrop blur radius in px — reference slider 0..12, default 1.5 */
  blur: number;
  /** specular rim strength 0..1 — reference default 0.55 */
  specular: number;
  /** white tint 0..1 — reference default 0.08 (the 8% slider) */
  tint: number;
  /** outer shadow strength 0..1 — reference default 0.5 */
  shadow: number;
}

/** The reference's shipped defaults, verbatim — this is `regular`. */
export const REFERENCE_PARAMS: RefractionParams = {
  thickness: 50,
  bezel: 60,
  ior: 3.0,
  blur: 1.5,
  specular: 0.55,
  tint: 0.08,
  shadow: 0.5,
};

/**
 * Per-level parameters. `regular` IS the reference default set; the other
 * levels scale thickness, bezel and blur off it so the ramp stays a ramp,
 * and `thick` takes the heavier thickness the demo reaches for.
 */
export const MATERIAL_PARAMS: Record<MaterialLevel, RefractionParams> = {
  ultrathin: {
    thickness: 20,
    bezel: 24,
    ior: 3.0,
    blur: 0.75,
    specular: 0.4,
    tint: 0.05,
    shadow: 0.35,
  },
  thin: { thickness: 35, bezel: 42, ior: 3.0, blur: 1.2, specular: 0.5, tint: 0.05, shadow: 0.42 },
  regular: { ...REFERENCE_PARAMS },
  thick: {
    thickness: 108,
    bezel: 60,
    ior: 3.0,
    blur: 3.0,
    specular: 0.5,
    tint: 0.08,
    shadow: 0.55,
  },
};
