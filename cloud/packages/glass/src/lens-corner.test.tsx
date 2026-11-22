// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { mapKey, renderDisplacement, renderSpecular } from './displacement-map';
import { GlassSurface } from './GlassSurface';
import { clampedRadius, CORNER_EXPONENT, cornerExponent, mapCorner, ROUND_PER_CURVE_RADIUS, roundPerCurve } from './squircle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE = [1, 0.8, 0.6, 0.4, 0.2, 0];
const map = (w: number, h: number, r: number, n?: number) => {
  const data = new Uint8ClampedArray(w * h * 4);
  renderDisplacement(data, w, h, r, 8, PROFILE, n);
  return (x: number, y: number) => [data[(y * w + x) * 4]!, data[(y * w + x) * 4 + 1]!];
};

describe('the lens ring traces the painted corner (WP-G5 composer ghost)', () => {
  it('clamps the radius like CSS before the map is built: a 44 px composer on a 52 px pill paints 26 px', () => {
    expect(clampedRadius(44, 720, 52)).toBe(26);
    expect(clampedRadius(42, 300, 400)).toBe(42);
  });

  it('reads the exponent from corner-shape, so a squircle sidebar and its fallback path agree', () => {
    expect(cornerExponent('superellipse(1.46)')).toBeCloseTo(CORNER_EXPONENT, 2);
    expect(cornerExponent('squircle')).toBe(4);
    expect(cornerExponent('round')).toBe(2);
    expect(roundPerCurve(CORNER_EXPONENT)).toBeCloseTo(ROUND_PER_CURVE_RADIUS, 2);
    expect(roundPerCurve(2)).toBeCloseTo(1, 6);
  });

  it('reads the span and the superellipse from the tokens that paint the surface', () => {
    const el = document.createElement('div');
    el.style.setProperty('--glass-radius', '44px');
    el.style.setProperty('--glass-corner', 'superellipse(1.46)');
    document.body.append(el);
    const corner = mapCorner(el, 720, 52, 'card');
    expect(corner.span).toBe(26);
    expect(corner.exponent).toBeCloseTo(CORNER_EXPONENT, 2);
    expect(mapCorner(el, 720, 52, 'capsule')).toEqual({ span: 26, exponent: 2 });
    el.remove();
  });

  it('bends the squircle apex, where a circle of the same span left a neutral gap and then a hard ring', () => {
    const r = 26;
    const p = 6; // 5.8 < 6 < 7.6, and past the circle's 1 px fade
    const circle = map(200, 52, r, 2);
    const squircle = map(200, 52, r, CORNER_EXPONENT);
    expect(circle(p, p)).toEqual([128, 128]);
    const [x, y] = squircle(p, p);
    expect(x).toBeGreaterThan(160); // pulls from inside, along the diagonal normal
    expect(y).toBeGreaterThan(160);
  });

  it('leaves circular maps bit for bit as kube draws them', () => {
    const a = new Uint8ClampedArray(120 * 80 * 4);
    const b = new Uint8ClampedArray(120 * 80 * 4);
    renderDisplacement(a, 120, 80, 20, 12, PROFILE);
    renderDisplacement(b, 120, 80, 20, 12, PROFILE, 2);
    expect(b).toEqual(a);
    const sa = new Uint8ClampedArray(60 * 60 * 4);
    const sb = new Uint8ClampedArray(60 * 60 * 4);
    renderSpecular(sa, 60, 60, 20, 2, -1, 1);
    renderSpecular(sb, 60, 60, 20, 2, -1, 1, 2);
    expect(sb).toEqual(sa);
  });

  it('lights the squircle rim at its own edge', () => {
    const w = 80;
    const data = new Uint8ClampedArray(w * w * 4);
    renderSpecular(data, w, w, 30, 2, (-60 * Math.PI) / 180, 1, CORNER_EXPONENT);
    const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3]!;
    const edge = Math.floor(30 * (1 - 0.5 ** (1 / CORNER_EXPONENT))) + 1; // first pixel inside the 45° apex
    expect(alpha(edge, edge)).toBeGreaterThan(0);
    expect(alpha(40, 40)).toBe(0);
  });

  it('keys the cache on the corner, so a capsule and a squircle of one size never share maps', () => {
    const spec = { width: 720, height: 52, radius: 26, bezel: 10, material: 'regular' as const };
    expect(mapKey(spec)).not.toBe(mapKey({ ...spec, exponent: CORNER_EXPONENT }));
  });
});

describe('opaque surfaces (lens={false})', () => {
  it('render one solid layer and no lens, filter or frost', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <GlassSurface lens={false} spotlight={false} material="thick">
          <p>content</p>
        </GlassSurface>,
      );
    });
    const surface = host.querySelector('[data-glass-surface]')!;
    expect(surface.getAttribute('data-glass-surface')).toBe('solid');
    expect(surface.querySelector(':scope > [data-glass-solid]')).not.toBeNull();
    expect(surface.querySelector('[data-glass-lens], svg, filter, [data-glass-spot]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });
});
