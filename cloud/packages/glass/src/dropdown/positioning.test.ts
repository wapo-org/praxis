import { describe, expect, it } from 'vitest';
import { placeMenu } from './positioning';
describe('dropdown viewport geometry', () => {
  for (const align of ['start', 'center', 'end'] as const) {
    for (const left of [0, 140, 370]) {
      it(`${align} at ${left}: fits 402×874 with 8px padding`, () => {
        const rect = {
          left,
          right: left + 32,
          top: 830,
          bottom: 862,
          width: 32,
        } as DOMRect;
        const position = placeMenu(
          rect,
          420,
          600,
          402,
          874,
          'bottom',
          align,
          8,
        );
        expect(position.side).toBe('top');
        expect(position.left).toBeGreaterThanOrEqual(8);
        expect(position.left + position.width).toBeLessThanOrEqual(394);
        expect(position.top).toBeGreaterThanOrEqual(8);
        expect(
          position.top + Math.min(600, position.maxHeight),
        ).toBeLessThanOrEqual(866);
      });
    }
  }
  it('shrinks to the available height and flips an explicit top preference', () => {
    const rect = {
      left: 10,
      right: 42,
      top: 0,
      bottom: 32,
      width: 32,
    } as DOMRect;
    expect(
      placeMenu(rect, 252, 900, 402, 874, 'top', 'start', 8),
    ).toMatchObject({ side: 'bottom', top: 40, maxHeight: 826 });
  });
});
