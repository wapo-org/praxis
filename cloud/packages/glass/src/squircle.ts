/**
 * Continuous corners. `corner-shape` (tokens.css, --glass-corner) does it natively, for free. An engine
 * without it (Firefox today) gets the same superellipse as a clip path on the glass's layers, rebuilt only
 * when the size changes: nothing per frame. The exponent is measured from the iOS menu (IMG_7868).
 */
export const CORNER_EXPONENT = 2.75;
/** The token is the curve's span. The circle with the same apex is this much smaller: the no-corner-shape paint and the morph's round phase use it. */
export const ROUND_PER_CURVE_RADIUS = 32 / 42;

const CORNER_STEPS = 12;

export function hasCornerShape(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('corner-shape', 'squircle');
}

/**
 * The superellipse exponent a `corner-shape` value paints: `superellipse(K)` is 2^K, the `squircle` keyword is
 * superellipse(2), `round` (or nothing) a circle.
 */
export function cornerExponent(value: string): number {
  const v = value.trim();
  if (v === 'squircle') return 4;
  const k = /superellipse\(\s*([\d.]+)\s*\)/.exec(v);
  return k ? 2 ** Number(k[1]) : 2;
}

/** The circle with the same 45° apex as a superellipse of span r, as a fraction of r (32/42 at n = 2.75). */
export function roundPerCurve(exponent: number): number {
  return (1 - 0.5 ** (1 / exponent)) / (1 - Math.SQRT1_2);
}

/** CSS scales every corner by one factor when they overlap; with equal corners that is this clamp. */
export function clampedRadius(radius: number, w: number, h: number): number {
  return Math.max(0, Math.min(radius, w / 2, h / 2));
}

/**
 * The corner a lens map must trace: its span after clamping and its superellipse exponent, read from the
 * same tokens that paint it (`--glass-radius`, `--glass-corner`). Capsules and `round` corners are circles.
 */
export function mapCorner(
  el: HTMLElement,
  w: number,
  h: number,
  shape: 'capsule' | 'card',
  radius?: number,
): { span: number; exponent: number } {
  if (shape === 'capsule') return { span: Math.min(w, h) / 2, exponent: 2 };
  const style = getComputedStyle(el);
  const token = radius ?? (Number.parseFloat(style.getPropertyValue('--glass-radius')) || 0);
  return { span: clampedRadius(token, w, h), exponent: cornerExponent(style.getPropertyValue('--glass-corner')) };
}

/** A closed path for a w x h box whose corners are a superellipse spanning `radius`. */
export function squirclePath(w: number, h: number, radius: number, exponent = CORNER_EXPONENT): string {
  const r = clampedRadius(radius, w, h);
  const points: string[] = [];
  const corner = (cx: number, cy: number, sx: number, sy: number, reverse: boolean) => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const t = ((reverse ? CORNER_STEPS - i : i) / CORNER_STEPS) * (Math.PI / 2);
      const x = cx + sx * r * Math.cos(t) ** (2 / exponent);
      const y = cy + sy * r * Math.sin(t) ** (2 / exponent);
      points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  };
  corner(w - r, r, 1, -1, false); // top right: right edge to top edge
  corner(r, r, -1, -1, true); // top left: top edge to left edge
  corner(r, h - r, -1, 1, false); // bottom left: left edge to bottom edge
  corner(w - r, h - r, 1, 1, true); // bottom right: bottom edge to right edge
  return `M${points.join('L')}Z`;
}

/** Attach the fallback to a card's root. A no-op where corner-shape exists. */
export function attachSquircle(el: HTMLElement): () => void {
  if (hasCornerShape() || typeof ResizeObserver === 'undefined') return () => {};
  let last = '';
  const build = () => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < 8 || h < 8) return;
    const style = getComputedStyle(el);
    const radius = Number.parseFloat(style.getPropertyValue('--glass-radius')) || 0;
    // The surface's own corner (the sidebar is `squircle`, the rest superellipse(1.46)).
    const exponent = cornerExponent(style.getPropertyValue('--glass-corner') || 'superellipse(1.46)');
    const key = `${w}x${h}r${radius}n${exponent}`;
    if (key === last) return;
    last = key;
    el.style.setProperty('--glass-radius-round', `${(radius * roundPerCurve(exponent)).toFixed(2)}px`);
    el.style.setProperty('--glass-squircle', `path("${squirclePath(w, h, radius, exponent)}")`);
  };
  // Now, not on the observer's first callback: whatever reads the corner on mount must see the final one.
  build();
  const observer = new ResizeObserver(build);
  observer.observe(el);
  return () => {
    observer.disconnect();
    el.style.removeProperty('--glass-squircle');
    el.style.removeProperty('--glass-radius-round');
  };
}
