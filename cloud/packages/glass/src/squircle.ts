export const CORNER_EXPONENT = 2.75;
export const ROUND_PER_CURVE_RADIUS = 32 / 42;

const CORNER_STEPS = 12;

export function hasCornerShape(): boolean {
  return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('corner-shape', 'squircle');
}

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
export function squirclePath(w: number, h: number, radius: number, exponent = CORNER_EXPONENT, offset = 0): string {
  const r = clampedRadius(radius, w, h);
  const points: string[] = [];
  const corner = (cx: number, cy: number, sx: number, sy: number, reverse: boolean) => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const t = ((reverse ? CORNER_STEPS - i : i) / CORNER_STEPS) * (Math.PI / 2);
      const x = offset + cx + sx * r * Math.cos(t) ** (2 / exponent);
      const y = offset + cy + sy * r * Math.sin(t) ** (2 / exponent);
      points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
    }
  };
  corner(w - r, r, 1, -1, false); // top right: right edge to top edge
  corner(r, r, -1, -1, true); // top left: top edge to left edge
  corner(r, h - r, -1, 1, false); // bottom left: left edge to bottom edge
  corner(w - r, h - r, 1, 1, true); // bottom right: bottom edge to right edge
  return `M${points.join('L')}Z`;
}

export function isClampedToCapsule(radius: number, w: number, h: number): boolean {
  return w >= 8 && h >= 8 && radius >= Math.min(w, h) / 2 - 0.5;
}

function tokenRadius(el: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(el).getPropertyValue('--glass-radius')) || 0;
}

/** Attach the clamp mark and, where corner-shape is missing, the path fallback to a card's root. */
export function attachSquircle(el: HTMLElement): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const native = hasCornerShape();
  let last = '';
  const build = () => {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w < 8 || h < 8) return;
    const radius = tokenRadius(el);
    if (isClampedToCapsule(radius, w, h)) el.dataset.glassCapsule = 'true';
    else delete el.dataset.glassCapsule;
    if (native) return;
    const style = getComputedStyle(el);
    // The surface's own corner (the sidebar is `squircle`, the rest superellipse(1.46)); round when clamped.
    const exponent = cornerExponent(style.getPropertyValue('--glass-corner') || 'superellipse(1.46)');
    const key = `${w}x${h}r${radius}n${exponent}`;
    if (key === last) return;
    last = key;
    el.style.setProperty('--glass-radius-round', `${(radius * roundPerCurve(exponent)).toFixed(2)}px`);
    el.style.setProperty('--glass-squircle', `path("${squirclePath(w, h, radius, exponent)}")`);
    el.dataset.glassPath = 'true';
    const outline = el.querySelector<SVGSVGElement>(':scope > [data-glass-outline]');
    if (outline) {
      outline.setAttribute('viewBox', `0 0 ${w} ${h}`);
      for (const line of outline.querySelectorAll<SVGPathElement>('path[data-inset]')) {
        const inset = Number(line.dataset.inset) || 0;
        line.setAttribute('d', squirclePath(w - 2 * inset, h - 2 * inset, radius - inset, exponent, inset));
      }
    }
  };
  // Now, not on the observer's first callback: whatever reads the corner on mount must see the final one.
  build();
  const observer = new ResizeObserver(build);
  observer.observe(el);
  return () => {
    observer.disconnect();
    delete el.dataset.glassCapsule;
    delete el.dataset.glassPath;
    el.style.removeProperty('--glass-squircle');
    el.style.removeProperty('--glass-radius-round');
  };
}
