import { describe, expect, it } from 'vitest';
import { contentShift } from './useContentShift';

const SIDEBAR_RIGHT = 244;
const gaps = (viewport: number, shift: number, column = 720) => {
  const width = Math.min(column, viewport - 48);
  const left = (viewport - width) / 2 + shift;
  return { left: left - SIDEBAR_RIGHT, right: viewport - (left + width) };
};

describe('contentShift', () => {
  it('centres the column in the area right of the open sidebar at every desktop width', () => {
    for (const viewport of [1024, 1100, 1280, 1440, 1920, 2560]) {
      const g = gaps(viewport, contentShift(viewport, 720, true));
      expect(Math.abs(g.left - g.right)).toBeLessThanOrEqual(0.5);
      expect(g.left).toBeGreaterThanOrEqual(24);
    }
  });
  it('keeps the owner’s 13.png case even: 124 px left vs 380 px right is now equal', () => {
    const g = gaps(1468, contentShift(1468, 720, true));
    expect(g.left).toBeCloseTo(g.right, 1);
  });
  it('does nothing when the sidebar is closed or on narrow screens', () => {
    expect(contentShift(1100, 720, false)).toBe(0);
    expect(contentShift(800, 720, true)).toBe(0);
  });
});
