import { describe, expect, it } from 'vitest';
import { contentShift } from './useContentShift';

describe('contentShift', () => {
  it('leaves a centred column alone when it already clears the sidebar', () => {
    expect(contentShift(1440, 720, true)).toBe(0);
  });
  it('moves the column clear of the sidebar on a smaller window, and keeps it on screen', () => {
    const shift = contentShift(1100, 720, true);
    expect(shift).toBeGreaterThan(0);
    const width = Math.min(720, 1100 - 308 - 24);
    expect((1100 - width) / 2 + shift).toBeGreaterThanOrEqual(308);
    expect((1100 + width) / 2 + shift).toBeLessThanOrEqual(1100);
  });
  it('does nothing when the sidebar is closed or on narrow screens', () => {
    expect(contentShift(1100, 720, false)).toBe(0);
    expect(contentShift(800, 720, true)).toBe(0);
  });
});
