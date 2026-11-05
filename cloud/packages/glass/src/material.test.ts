import { describe, expect, it } from 'vitest';
import { generateMaps, renderDisplacement, renderSpecular } from './displacement-map';
import { chromaOffsets, isChromiumEngine, lensScale, MATERIAL_RAMP } from './material';

const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const firefox = 'Mozilla/5.0 (Macintosh; rv:140.0) Gecko/20100101 Firefox/140.0';
const crios = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1';

describe('tier negotiation', () => {
  it('gives the lens to Chromium only: iOS Chrome is WebKit underneath', () => {
    expect(isChromiumEngine({ userAgent: chrome })).toBe(true);
    expect(isChromiumEngine({ userAgent: 'x', userAgentData: { brands: [{ brand: 'Chromium' }] } })).toBe(true);
    for (const userAgent of [safari, firefox, crios]) expect(isChromiumEngine({ userAgent })).toBe(false);
  });
});

describe('the lens constants', () => {
  it('wakes from 0.8 to 1.0 of the shipped kube.io displacement', () => {
    expect(lensScale('regular', false)).toBeCloseTo(98.247, 2);
    expect(lensScale('regular', true)).toBeCloseTo(122.809, 2);
  });
  it('thicker glass wobbles less and settles slower', () => {
    expect(MATERIAL_RAMP.thick.bounce).toBeLessThan(MATERIAL_RAMP.regular.bounce);
    expect(MATERIAL_RAMP.thick.settle).toBeGreaterThan(MATERIAL_RAMP.regular.settle);
  });
  it('puts warm paper on its own luma and leaves neutral alone', () => {
    const offsets = chromaOffsets([251, 251, 249])!;
    expect(offsets.ob).toBeGreaterThan(0); // warm paper: blue comes up
    expect(chromaOffsets([128, 128, 128])).toBeNull();
    expect(chromaOffsets(null)).toBeNull();
  });
});

describe('displacement map', () => {
  const render = (w: number, h: number, radius: number, bezel: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    renderDisplacement(data, w, h, radius, bezel, MAP_PROFILE);
    return { at: (x: number, y: number) => [data[(y * w + x) * 4], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4 + 2], data[(y * w + x) * 4 + 3]] };
  };
  const MAP_PROFILE = [1, 0.8, 0.6, 0.4, 0.2, 0];
  it('is neutral away from the bezel, so the core of the glass never distorts', () => {
    const map = render(120, 80, 20, 20);
    expect(map.at(60, 40)).toEqual([128, 128, 0, 255]);
    expect(map.at(30, 40)).toEqual([128, 128, 0, 255]);
  });
  it('bends inward along the border normal', () => {
    const map = render(120, 80, 20, 20);
    const left = map.at(1, 40);
    const top = map.at(60, 1);
    expect(left[0]).toBeGreaterThan(200); // samples to the right, from inside
    expect(left[1]).toBe(128);
    expect(top[1]).toBeGreaterThan(200); // samples downward, from inside
    expect(top[0]).toBe(128);
  });
  it('keeps a full ring when the bezel is wider than the corner', () => {
    const map = render(120, 80, 10, 32);
    expect(map.at(1, 40)[0]).toBeGreaterThan(200);
    expect(map.at(8, 40)[0]).toBeGreaterThan(128);
    expect(map.at(14, 40)[0]).toBe(128);
  });
  it('lights the rim and nothing else', () => {
    const w = 60;
    const data = new Uint8ClampedArray(w * w * 4);
    renderSpecular(data, w, w, 20, 2, (-60 * Math.PI) / 180, 1);
    const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    expect(alpha(30, 1)).toBeGreaterThan(0);
    expect(alpha(30, 30)).toBe(0);
  });
  it('has no canvas in tests: maps are simply absent and the frost carries the surface', () => {
    if (typeof document === 'undefined') expect(() => generateMaps({ width: 10, height: 10, radius: 5, bezel: 5, material: 'clear' })).toThrow();
  });
});
