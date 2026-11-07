/**
 * Continuous corners. `corner-shape` (tokens.css, --glass-corner) does it natively, for free. An engine
 * without it (Firefox today) gets the same superellipse as a clip path on the glass's layers, rebuilt only
 * when the size changes: nothing per frame. The exponent is measured from the iOS menu (IMG_7868).
 */
export const CORNER_EXPONENT = 2.75;
/** The token radius on an engine without corner-shape is the circle with the same apex; the curve spans this much more. */
export const CURVE_PER_ROUND_RADIUS = 42 / 32;
/** ... and the circle a map should use on a corner-shape engine, where the token is the curve's span. */
export const ROUND_PER_CURVE_RADIUS = 32 / 42;

const CORNER_STEPS = 12;

export function hasCornerShape(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('corner-shape', 'squircle');
}

/** A closed path for a w x h box whose corners are a superellipse spanning `radius`. */
export function squirclePath(w: number, h: number, radius: number, exponent = CORNER_EXPONENT): string {
  const r = Math.min(radius, w / 2, h / 2);
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
    const radius = Number.parseFloat(getComputedStyle(el).getPropertyValue('--glass-radius')) || 0;
    const key = `${w}x${h}r${radius}`;
    if (key === last) return;
    last = key;
    el.style.setProperty('--glass-squircle', `path("${squirclePath(w, h, radius * CURVE_PER_ROUND_RADIUS)}")`);
  };
  const observer = new ResizeObserver(build);
  observer.observe(el);
  return () => {
    observer.disconnect();
    el.style.removeProperty('--glass-squircle');
  };
}
