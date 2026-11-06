import { describe, expect, it } from 'vitest';
import { MORPH, type SpringValue } from '../motion';
import { contentAt, MAX_SUBSTEP, shapeAt, stepSpring, type MorphGeometry, type SpringState } from './math';

const below: MorphGeometry = {
  source: { left: 348, top: 14, width: 42, height: 36 },
  sourceRadius: 18,
  final: { left: 154, top: 58, width: 236, height: 175 },
  radius: 16,
};
const above: MorphGeometry = { ...below, source: { left: 12, top: 826, width: 42, height: 36 }, final: { left: 12, top: 640, width: 236, height: 175 } };

const run = (spec: SpringValue, seconds: number, delay = 0, from: SpringState = { x: 0, v: 0 }, target = 1) => {
  const state = { ...from };
  let t = 0;
  while (t < seconds) {
    if (t >= delay) stepSpring(state, target, spec, MAX_SUBSTEP);
    t += MAX_SUBSTEP;
  }
  return state;
};

describe('the morph path', () => {
  it('starts exactly on the source and rests exactly on the menu', () => {
    const start = shapeAt(0, 0, 1, below);
    expect(start.left).toBeCloseTo(below.source.left, 5);
    expect(start.top).toBeCloseTo(below.source.top, 5);
    expect(start.width).toBeCloseTo(below.source.width, 5);
    expect(start.height).toBeCloseTo(below.source.height, 5);
    expect(start.radius).toBeCloseTo(below.sourceRadius, 5);
    const end = shapeAt(1, 1, 0, below);
    expect(end.left).toBeCloseTo(below.final.left, 5);
    expect(end.top).toBeCloseTo(below.final.top, 5);
    expect(end.width).toBeCloseTo(below.final.width, 5);
    expect(end.height).toBeCloseTo(below.final.height, 5);
    expect(end.radius).toBeCloseTo(below.radius, 5);
  });

  it('has no jump anywhere: a tiny step in progress is a tiny step on screen', () => {
    for (const g of [below, above]) {
      let last = shapeAt(0, 0, 1, g);
      for (let i = 1; i <= 2000; i++) {
        const p = i / 2000;
        const next = shapeAt(p, p, 1 - p, g);
        for (const key of ['left', 'top', 'width', 'height', 'radius'] as const) {
          expect(Math.abs(next[key] - last[key]), `${key} at ${p}`).toBeLessThan(1.2);
        }
        last = next;
      }
    }
  });

  it('is a near-circle mid-way, whatever the menu proportions', () => {
    const wide = { ...below, final: { left: 0, top: 60, width: 320, height: 120 } };
    const shape = shapeAt(0.4, 0.2, 1, wide);
    expect(shape.width / shape.height).toBeLessThan(1.15);
    expect(shape.radius).toBeCloseTo(Math.min(shape.width, shape.height) / 2, 3);
  });

  it('keeps the far edge near the button, and mirrors for a menu opening upward and rightward', () => {
    const down = shapeAt(0.6, 0.3, 1, below);
    const edge = down.left + down.width - (below.final.left + below.final.width);
    expect(edge).toBeLessThanOrEqual(1);
    expect(edge).toBeGreaterThan(-16);
    const up = shapeAt(0.6, 0.3, 1, above);
    expect(up.left - above.final.left).toBeGreaterThanOrEqual(-1);
    expect(up.left - above.final.left).toBeLessThan(16);
    expect(up.top + up.height).toBeLessThanOrEqual(above.final.top + above.final.height + 6);
    expect(up.top + up.height).toBeGreaterThan(above.source.top - 60);
  });

  it('carries past its place away from the button while the rows arrive, then comes back', () => {
    const carried = shapeAt(1, 0.6, 0, below);
    expect(carried.top).toBeGreaterThan(below.final.top + 10);
    expect(shapeAt(1, 1, 0, below).top).toBeCloseTo(below.final.top, 5);
    const mirrored = shapeAt(1, 0.6, 0, above);
    expect(mirrored.top).toBeLessThan(above.final.top - 10);
  });

  it('loses the last 2-3 % slowly, with no overshoot below the rest size', () => {
    const settling = shapeAt(1, 1, 1, below);
    expect(settling.height / below.final.height).toBeGreaterThan(1.02);
    expect(settling.height / below.final.height).toBeLessThan(1.04);
    for (const settle of [0.8, 0.5, 0.2, 0]) expect(shapeAt(1, 1, settle, below).height).toBeGreaterThanOrEqual(below.final.height - 1e-6);
  });
});

describe('the morph timing, against the reference', () => {
  const at = (ms: number) => ({
    p: run(MORPH.open.shape, ms / 1000, MORPH.open.shapeDelay).x,
    c: run(MORPH.open.content, ms / 1000, MORPH.open.contentDelay).x,
  });

  it('does nearly all its growth in about 150 ms after the lift', () => {
    expect(at(100).p).toBe(0);
    expect(at(170).p).toBeLessThan(0.75);
    expect(at(170).p).toBeGreaterThan(0.45);
    expect(at(270).p).toBeGreaterThan(0.97);
  });

  it('lands the rows after the fast phase: oversized at 230, sharp by 320, in place by 500', () => {
    expect(contentAt(at(170).c).sharp).toBe(0);
    const mid = contentAt(at(230).c);
    expect(mid.scale).toBeGreaterThan(1.15);
    expect(mid.scale).toBeLessThan(1.3);
    expect(mid.blurred).toBeGreaterThan(0.9);
    const landed = contentAt(at(320).c);
    expect(landed.sharp).toBeGreaterThan(0.95);
    expect(landed.tint).toBeGreaterThan(0.9);
    expect(contentAt(at(500).c).scale).toBeLessThan(1.01);
  });

  it('never overshoots: there is no bounce at all', () => {
    const state: SpringState = { x: 0, v: 0 };
    for (let i = 0; i < 2000; i++) {
      stepSpring(state, 1, MORPH.open.shape, MAX_SUBSTEP);
      expect(state.x).toBeLessThanOrEqual(1.0001);
    }
  });

  it('reverses from where it is, with its velocity, and closes faster than it opens', () => {
    const mid = run(MORPH.open.shape, 0.05);
    expect(mid.x).toBeGreaterThan(0.1);
    expect(mid.v).toBeGreaterThan(0);
    const next = { ...mid };
    stepSpring(next, 0, MORPH.close.shape, MAX_SUBSTEP);
    expect(Math.abs(next.x - mid.x)).toBeLessThan(0.02); // no jump
    expect(next.v).toBeGreaterThan(0); // still moving the way it was
    const openTime = () => { const s = { x: 0, v: 0 }; let t = 0; while (s.x < 0.95) { stepSpring(s, 1, MORPH.open.shape, MAX_SUBSTEP); t += MAX_SUBSTEP; } return t; };
    const closeTime = () => { const s = { x: 1, v: 0 }; let t = 0; while (s.x > 0.05) { stepSpring(s, 0, MORPH.close.shape, MAX_SUBSTEP); t += MAX_SUBSTEP; } return t; };
    expect(closeTime()).toBeLessThan(openTime());
  });
});
