import { describe, expect, it } from 'vitest';
import { MORPH, type SpringValue } from '../motion';
import { contentAt, MAX_SUBSTEP, shapeAt, stepSpring, type MorphGeometry, type SpringState } from './math';

const below: MorphGeometry = {
  source: { left: 348, top: 14, width: 42, height: 36 },
  sourceRadius: 18,
  final: { left: 154, top: 58, width: 236, height: 196 },
  radius: 42,
  corner: 1.46,
};
const above: MorphGeometry = { ...below, source: { left: 12, top: 826, width: 42, height: 36 }, final: { left: 12, top: 620, width: 236, height: 196 } };

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
  it('starts exactly on the source and rests exactly on the menu, in the rest corner', () => {
    const start = shapeAt(0, 0, below);
    expect(start.left).toBeCloseTo(below.source.left, 5);
    expect(start.top).toBeCloseTo(below.source.top, 5);
    expect(start.width).toBeCloseTo(below.source.width, 5);
    expect(start.height).toBeCloseTo(below.source.height, 5);
    expect(start.radius).toBeCloseTo(below.sourceRadius, 5);
    expect(start.corner).toBeCloseTo(1, 5);
    const end = shapeAt(1, 1, below);
    expect(end.left).toBeCloseTo(below.final.left, 5);
    expect(end.top).toBeCloseTo(below.final.top, 5);
    expect(end.width).toBeCloseTo(below.final.width, 5);
    expect(end.height).toBeCloseTo(below.final.height, 5);
    expect(end.radius).toBeCloseTo(below.radius, 5);
    expect(end.corner).toBeCloseTo(below.corner, 5);
  });

  it('has no jump anywhere: a tiny step in progress is a tiny step on screen', () => {
    for (const g of [below, above]) {
      let last = shapeAt(0, 0, g);
      for (let i = 1; i <= 2000; i++) {
        const p = i / 2000;
        const next = shapeAt(p, p, g);
        for (const key of ['left', 'top', 'width', 'height', 'radius'] as const) {
          expect(Math.abs(next[key] - last[key]), `${key} at ${p}`).toBeLessThan(1.5);
        }
        last = next;
      }
    }
  });

  it('holds a circle until the rows have nearly arrived, for a reference-sized menu', () => {
    for (const c of [0.2, 0.4, 0.6, 0.72]) {
      const shape = shapeAt(1, c, below);
      expect(shape.width / shape.height, `c ${c}`).toBeCloseTo(1, 1);
    }
    const squared = shapeAt(1, 0.86, below);
    expect(squared.width).toBeCloseTo(below.final.width, 3);
    expect(squared.height).toBeCloseTo(below.final.height, 3);
  });

  it('keeps the radius larger than final while it squares up, and only then reaches the corner', () => {
    expect(shapeAt(1, 0.8, below).radius).toBeGreaterThan(below.radius + 5);
    expect(shapeAt(1, 0.8, below).corner).toBeLessThan(below.corner);
    expect(shapeAt(1, 0.92, below).radius).toBeCloseTo(below.radius, 3);
  });

  it('a very wide menu cannot be a circle, but is much rounder than its box', () => {
    const wide = { ...below, final: { left: 0, top: 60, width: 360, height: 120 } };
    const shape = shapeAt(1, 0.3, wide);
    expect(shape.width / shape.height).toBeLessThan(2);
    expect(shape.width / shape.height).toBeGreaterThan(1.2);
    expect(shape.radius).toBeCloseTo(shape.height / 2, 3);
  });

  it('the edge beside the button never swings past its place, and that mirrors', () => {
    for (let i = 0; i <= 100; i++) {
      const p = 0.4 + (i / 100) * 0.64;
      const c = Math.min(1, p);
      const down = shapeAt(p, c, below);
      expect(down.left + down.width, `right at ${p}`).toBeLessThanOrEqual(below.final.left + below.final.width + 1);
      expect(down.top, `top at ${p}`).toBeLessThanOrEqual(below.final.top + 0.01);
      const up = shapeAt(p, c, above);
      expect(up.left, `left at ${p}`).toBeGreaterThanOrEqual(above.final.left - 1);
      expect(up.top + up.height, `bottom at ${p}`).toBeGreaterThanOrEqual(above.final.top + above.final.height - 0.01);
    }
  });

  it('past 1 the far edges overshoot and return; the near edges stay', () => {
    const over = shapeAt(1.035, 1, below);
    expect(over.width).toBeGreaterThan(below.final.width + 4);
    expect(over.height).toBeGreaterThan(below.final.height + 4);
    expect(Math.abs(over.left + over.width - (below.final.left + below.final.width))).toBeLessThan(1);
    expect(over.top).toBeCloseTo(below.final.top, 3);
  });
});

describe('the morph timing, 15 % faster than the reference', () => {
  const at = (ms: number) => ({
    p: run(MORPH.open.shape, ms / 1000, MORPH.open.shapeDelay, undefined, 1 + MORPH.open.overshoot).x,
    c: run(MORPH.open.content, ms / 1000, MORPH.open.contentDelay).x,
  });

  it('does nearly all its growth in about 110 ms after the lift', () => {
    expect(at(90).p).toBe(0);
    expect(at(145).p).toBeGreaterThan(0.6);
    expect(at(145).p).toBeLessThan(0.9);
    expect(at(205).p).toBeGreaterThan(0.97);
  });

  it('the rows are sharp, inked and in place before the shape reaches 95 % of its size (WP-G4)', () => {
    const p: SpringState = { x: 0, v: 0 };
    const c: SpringState = { x: 0, v: 0 };
    const f: SpringState = { x: 0, v: 0 };
    let t = 0;
    let shape95 = 0;
    let rowsDone = 0;
    let peak = 0;
    let blurredSeen = false;
    while (t < 0.8) {
      stepSpring(p, t >= MORPH.open.shapeDelay ? (f.x >= MORPH.open.landAt ? 1 : 1 + MORPH.open.overshoot) : 0, MORPH.open.shape, MAX_SUBSTEP);
      stepSpring(c, t >= MORPH.open.contentDelay ? 1 : 0, MORPH.open.content, MAX_SUBSTEP);
      stepSpring(f, t >= MORPH.open.contentDelay ? 1 : 0, MORPH.open.form, MAX_SUBSTEP);
      t += MAX_SUBSTEP;
      const shape = shapeAt(p.x, f.x, below);
      const pose = contentAt(c.x);
      peak = Math.max(peak, shape.width / below.final.width);
      if (pose.blurred > 0.5) blurredSeen = true;
      if (!shape95 && shape.width >= 0.95 * below.final.width && shape.height >= 0.95 * below.final.height) shape95 = t;
      if (!rowsDone && pose.sharp > 0.995 && pose.blurred < 0.005 && pose.tint > 0.995 && Math.abs(pose.scale - 1) < 0.005) rowsDone = t;
    }
    expect(blurredSeen).toBe(true); // they still arrive blurred
    expect(rowsDone).toBeGreaterThan(0);
    expect(rowsDone).toBeLessThan(shape95);
    expect(shape95).toBeLessThan(0.26);
    expect(peak).toBeGreaterThan(1.015); // the overshoot is kept
  });

  it('the overshoot is small and visible: the aim, plus almost no ringing', () => {
    const state: SpringState = { x: 0, v: 0 };
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
      stepSpring(state, 1 + MORPH.open.overshoot, MORPH.open.shape, MAX_SUBSTEP);
      peak = Math.max(peak, state.x);
    }
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.06);
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
    expect(closeTime()).toBeLessThan(MORPH.open.shapeDelay + openTime());
  });
});
