/**
 * Runtime displacement and specular maps: the kube.io liquid-glass generator,
 * ported from wapo.dp `src/lib/glass/displacement-map.ts`. See that file for
 * how the tables were measured from the shipped maps.
 *
 * Differences from the source, all cost or correctness:
 *  - Loops visit only the bezel ring; the interior is the neutral fill anyway.
 *  - The ring is clamped to the radius, so a bezel wider than the corner (a
 *    sidebar with a 20 px radius and a 32 px bezel) stays a full ring instead of
 *    collapsing to a thin band.
 *  - Maps are built at rest size only, never during a gesture, and cached.
 *  - Maps are far smaller than the source's: see PIXEL_BUDGET.
 */
import type { GlassMaterial } from './material';

/** Normalized bezel profiles at 0.5 element-px steps, border = 1. */
const PROFILES: Record<GlassMaterial, readonly number[]> = {
  // searchbox
  clear: [
    1.0, 0.9394, 0.8283, 0.697, 0.6263, 0.5556, 0.4848, 0.4444, 0.404, 0.3535, 0.3232, 0.2828, 0.2626, 0.2424, 0.2121,
    0.1919, 0.1818, 0.1616, 0.1414, 0.1313, 0.1212, 0.1111, 0.0909, 0.0909, 0.0808, 0.0707, 0.0606, 0.0505, 0.0505,
    0.0404, 0.0404, 0.0303, 0.0303, 0.0202, 0.0202, 0.0202, 0.0202, 0.0101, 0.0101, 0.0101, 0.0101, 0.0101, 0.0,
  ],
  // magnifier
  regular: [
    1.0, 1.0, 0.874, 0.7795, 0.6614, 0.5906, 0.5118, 0.4646, 0.4016, 0.3543, 0.3228, 0.2835, 0.2598, 0.2283, 0.2126,
    0.189, 0.1732, 0.1496, 0.1339, 0.126, 0.1102, 0.0945, 0.0866, 0.0787, 0.0709, 0.0551, 0.0551, 0.0472, 0.0394,
    0.0315, 0.0315, 0.0236, 0.0236, 0.0157, 0.0157, 0.0157, 0.0079, 0.0079, 0.0079, 0.0079, 0.0,
  ],
  // hero circle
  thick: [
    1.0, 1.0, 1.0, 1.0, 0.9528, 0.8504, 0.8031, 0.7244, 0.6929, 0.622, 0.5669, 0.5433, 0.4961, 0.4724, 0.4331, 0.3937,
    0.378, 0.3465, 0.3386, 0.3071, 0.2835, 0.2677, 0.252, 0.2362, 0.2205, 0.2047, 0.1969, 0.1811, 0.1732, 0.1575,
    0.1417, 0.1417, 0.126, 0.1181, 0.1102, 0.1024, 0.0945, 0.0866, 0.0866, 0.0787, 0.0709, 0.063, 0.063, 0.0551,
    0.0472, 0.0472, 0.0394, 0.0394, 0.0394, 0.0315, 0.0315, 0.0236, 0.0236, 0.0236, 0.0157, 0.0157, 0.0157, 0.0157,
    0.0157, 0.0079, 0.0079, 0.0079, 0.0079, 0.0079, 0.0079, 0.0,
  ],
};

export interface MapSpec {
  width: number;
  height: number;
  radius: number;
  bezel: number;
  material: GlassMaterial;
  /** Map pixel budget before the render downsamples. See PIXEL_BUDGET. */
  pixelBudget?: number;
}

export interface GeneratedMaps {
  width: number;
  height: number;
  displacementUrl: string;
  specularUrl: string;
  frostMaskUrl: string;
}

/** Calls `visit(x, y)` for the pixels within `band` map px of the border, row by row. */
function forRing(mw: number, mh: number, band: number, visit: (x: number, y: number) => void) {
  const inset = Math.ceil(band) + 1;
  for (let y = 0; y < mh; y++) {
    const full = y < inset || y >= mh - inset;
    for (let x = 0; x < mw; x++) {
      if (!full && x === inset && mw - inset > x) x = mw - inset;
      visit(x, y);
    }
  }
}

/** Kube's Qt ring renderer: exact radial direction per pixel, baked depth curve, 1 px fade. */
export function renderDisplacement(
  target: Uint8ClampedArray,
  mw: number,
  mh: number,
  radius: number,
  bezel: number,
  profile: readonly number[],
): void {
  new Uint32Array(target.buffer, target.byteOffset, target.length / 4).fill(0xff008080);
  const r = Math.min(radius, Math.min(mw, mh) / 2);
  const m = Math.max(1, Math.min(bezel, r));
  const inner2 = (r - m) * (r - m);
  const border2 = r * r;
  const outer2 = (r + 1) * (r + 1);
  const spanX = mw - 2 * r;
  const spanY = mh - 2 * r;
  const n = profile.length;
  forRing(mw, mh, Math.max(m, r), (t, e) => {
    const d = e < r ? e - r : e >= mh - r ? e - r - spanY : 0;
    const l = t < r ? t - r : t >= mw - r ? t - r - spanX : 0;
    const s = l * l + d * d;
    if (s > outer2 || s < inner2 || s === 0) return;
    const dist = Math.sqrt(s);
    const fade = s < border2 ? 1 : 1 - (dist - r);
    const depth = r - dist;
    const c = profile[((depth / m) * n) | 0] ?? 0;
    const k = c * 127 * fade;
    const i = (e * mw + t) * 4;
    target[i] = Math.round(128 - (l / dist) * k);
    target[i + 1] = Math.round(128 - (d / dist) * k);
  });
}

/** Kube's Yr rim renderer: a semicircular profile over the outer 2 device pixels, lit at -60°. */
export function renderSpecular(
  target: Uint8ClampedArray,
  mw: number,
  mh: number,
  radius: number,
  rimWidth: number,
  lightAngle: number,
  dpr: number,
): void {
  const u = Math.min(radius, Math.min(mw, mh) / 2);
  const rim = Math.max(2, rimWidth) * dpr;
  const lightX = Math.cos(lightAngle);
  const lightY = Math.sin(lightAngle);
  const border2 = u * u;
  const outer2 = (u + dpr) * (u + dpr);
  const inner = Math.max(0, u - rim);
  const inner2 = inner * inner;
  const spanX = mw - 2 * u;
  const spanY = mh - 2 * u;
  forRing(mw, mh, Math.max(rim, u), (t, e) => {
    const dy = e < u ? e - u : e >= mh - u ? e - u - spanY : 0;
    const dx = t < u ? t - u : t >= mw - u ? t - u - spanX : 0;
    const b = dx * dx + dy * dy;
    if (b > outer2 || b < inner2 || b === 0) return;
    const dist = Math.sqrt(b);
    const depth = u - dist;
    const fade = b < border2 ? 1 : 1 - (dist - u) / dpr;
    const arc = Math.sqrt(Math.max(0, 1 - (1 - depth / dpr) ** 2));
    const s = Math.abs((dx / dist) * lightX + (-dy / dist) * lightY) * arc;
    const c = 255 * s;
    const i = (e * mw + t) * 4;
    const cc = Math.round(Math.min(255, c));
    target[i] = cc;
    target[i + 1] = cc;
    target[i + 2] = cc;
    target[i + 3] = Math.round(Math.min(255, Math.max(0, c * s * fade)));
  });
}

/** The progressive-frost rim mask: alpha rises from the core to the rim on the inscribed ellipse. */
function paintFrostMask(canvas: HTMLCanvasElement, mw: number, mh: number): boolean {
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.translate(mw / 2, mh / 2);
  ctx.scale(mw / 2, mh / 2);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.98, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = gradient;
  ctx.fillRect(-1, -1, 2, 2);
  return true;
}

function frostMask(canvas: HTMLCanvasElement, mw: number, mh: number): string | null {
  return paintFrostMask(canvas, mw, mh) ? canvas.toDataURL('image/png') : null;
}

/**
 * Chromium re-uploads feImage textures on every frame the lens redraws, so map
 * size is the lens's main cost: measured headed on an M4 Pro at 120 Hz, a sidebar
 * at the source's 1.1M budget drops scrolling to 60 Hz; at this budget it holds 120.
 * Displacement is smooth and bilinear-filtered back up, so it loses nothing visible;
 * the crisp 1 px rim on big surfaces comes from the CSS finish.
 */
export const PIXEL_BUDGET = 60_000;
/** The frost mask is one smooth radial gradient, so it never needs more than this. */
const MASK_SIZE = 96;

/** Bounded: oldest geometry out first. Sizes repeat, so this rarely evicts. */
const CACHE_LIMIT = 48;
const cache = new Map<string, GeneratedMaps>();

export function mapKey(spec: MapSpec): string {
  return `${Math.round(spec.width)}x${Math.round(spec.height)}r${Math.round(spec.radius)}b${Math.round(spec.bezel * 2)}${spec.material}`;
}

export function mapCacheSize(): number {
  return cache.size;
}

export function generateMaps(spec: MapSpec): GeneratedMaps | null {
  const key = mapKey(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const budget = spec.pixelBudget ?? PIXEL_BUDGET;
  const raw = spec.width * spec.height * dpr * dpr;
  const eff = raw > budget ? dpr * Math.sqrt(budget / raw) : dpr;
  const mw = Math.max(2, Math.round(spec.width * eff));
  const mh = Math.max(2, Math.round(spec.height * eff));
  const canvas = document.createElement('canvas');
  canvas.width = mw;
  canvas.height = mh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(mw, mh);
  const radius = spec.radius * eff;
  renderDisplacement(image.data, mw, mh, radius, spec.bezel * eff, PROFILES[spec.material]);
  ctx.putImageData(image, 0, 0);
  const displacementUrl = canvas.toDataURL('image/png');
  image.data.fill(0);
  renderSpecular(image.data, mw, mh, radius, 2, (-60 * Math.PI) / 180, eff);
  ctx.putImageData(image, 0, 0);
  const specularUrl = canvas.toDataURL('image/png');
  const frostMaskUrl = frostMask(canvas, Math.min(mw, MASK_SIZE), Math.min(mh, MASK_SIZE));
  if (!displacementUrl || !specularUrl || !frostMaskUrl) return null;
  const maps = { width: spec.width, height: spec.height, displacementUrl, specularUrl, frostMaskUrl };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, maps);
  return maps;
}


/** Browser PNG encoding is asynchronous: cold menu opens must not block on toDataURL. */
function encodePNG(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise(resolve => canvas.toBlob(blob => {
    if (!blob) { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  }, 'image/png'));
}
const pendingMaps = new Map<string, Promise<GeneratedMaps | null>>();
export function generateMapsAsync(spec: MapSpec): Promise<GeneratedMaps | null> {
  const key = mapKey(spec);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = pendingMaps.get(key);
  if (pending) return pending;
  const build = async () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const eff = Math.min(dpr, Math.sqrt((spec.pixelBudget ?? PIXEL_BUDGET) / (spec.width * spec.height)));
    const mw = Math.max(2, Math.round(spec.width * eff)), mh = Math.max(2, Math.round(spec.height * eff));
    const canvas = document.createElement('canvas');
    canvas.width = mw; canvas.height = mh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(mw, mh);
    renderDisplacement(image.data, mw, mh, spec.radius * eff, spec.bezel * eff, PROFILES[spec.material]);
    ctx.putImageData(image, 0, 0);
    const displacementUrl = await encodePNG(canvas);
    image.data.fill(0);
    renderSpecular(image.data, mw, mh, spec.radius * eff, 2, (-60 * Math.PI) / 180, eff);
    ctx.putImageData(image, 0, 0);
    const specularUrl = await encodePNG(canvas);
    if (!paintFrostMask(canvas, Math.min(mw, MASK_SIZE), Math.min(mh, MASK_SIZE))) return null;
    const frostMaskUrl = await encodePNG(canvas);
    if (!displacementUrl || !specularUrl || !frostMaskUrl) return null;
    const maps = { width: spec.width, height: spec.height, displacementUrl, specularUrl, frostMaskUrl };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, maps);
    return maps;
  };
  const task = build().finally(() => pendingMaps.delete(key));
  pendingMaps.set(key, task);
  return task;
}
