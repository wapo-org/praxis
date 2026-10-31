import { expect, it } from 'vitest';
import { isScrollPan } from './gestures';
it('requires a threshold and a matching scroll axis for native pans', () => {
  expect(isScrollPan(0, 7, true, false)).toBe(false);
  expect(isScrollPan(2, 20, true, false)).toBe(true);
  expect(isScrollPan(20, 2, true, false)).toBe(false);
  expect(isScrollPan(20, 2, false, true)).toBe(true);
  expect(isScrollPan(20, 20, true, false)).toBe(false);
  expect(isScrollPan(0, 40, false, false)).toBe(false);
});
