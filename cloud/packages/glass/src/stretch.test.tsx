// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlassSurface } from './GlassSurface';
import { axisBudget, computeStretch, directionalBudget, PULL_ENGAGE_PX, pullForTravel, saturatePull, scrollerTakesMove, selectionWins, shouldSwallowClick } from './stretch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('stretch math (ported from the source)', () => {
  it('saturates: travel approaches the budget and never passes it', () => {
    expect(saturatePull(3, 38)).toBeCloseTo(3, 0); // no jump at engage
    expect(saturatePull(1000, 38)).toBeLessThanOrEqual(38);
    expect(saturatePull(60, 38)).toBeLessThan(saturatePull(120, 38));
  });
  it('rotates the budget continuously with the pointer', () => {
    expect(directionalBudget(1, 0, 30, 10)).toBeCloseTo(30);
    expect(directionalBudget(0, 1, 30, 10)).toBeCloseTo(10);
    const diagonal = directionalBudget(Math.SQRT1_2, Math.SQRT1_2, 30, 10);
    expect(diagonal).toBeGreaterThan(10);
    expect(diagonal).toBeLessThan(30);
  });
  it('budgets about 1 cm or 22% of the axis, per material', () => {
    expect(axisBudget(1000, 'regular')).toBeCloseTo(37.8);
    expect(axisBudget(100, 'regular')).toBeCloseTo(22);
    expect(axisBudget(1000, 'thick')).toBeGreaterThan(axisBudget(1000, 'regular'));
    expect(axisBudget(1000, 'clear')).toBeLessThan(axisBudget(1000, 'regular'));
  });
  it('keeps the pull direction exactly', () => {
    const pull = pullForTravel(30, 40, 38, 38);
    expect(pull.y / pull.x).toBeCloseTo(40 / 30);
    expect(pullForTravel(0, 0, 38, 38)).toEqual({ x: 0, y: 0 });
  });
  it('anchors the far side: a pull right moves only the right edge', () => {
    const pose = computeStretch(20, 0, 200, 100)!;
    const left = -100 * pose.scaleX + pose.translateX;
    const right = 100 * pose.scaleX + pose.translateX;
    expect(left).toBeCloseTo(-100);
    expect(right).toBeCloseTo(120);
    expect(pose.scaleY).toBe(1);
  });
  it('stays anchored for a transform-origin in a corner', () => {
    const pose = computeStretch(-16, 0, 200, 100, -100, 50)!;
    // Around origin (-100): the right edge at +100 must stay, the left edge reaches -116.
    expect(-100 + (100 + 100) * pose.scaleX + pose.translateX).toBeCloseTo(100);
    expect(-100 + (-100 + 100) * pose.scaleX + pose.translateX).toBeCloseTo(-116);
  });
  it('is the identity at rest', () => {
    expect(computeStretch(0, 0, 200, 100)).toBeNull();
  });
  it('swallows only trusted clicks, so a synthetic row.click() still selects', () => {
    expect(shouldSwallowClick({ isTrusted: true })).toBe(true);
    expect(shouldSwallowClick({ isTrusted: false })).toBe(false);
  });
});

describe('who owns a press', () => {
  const host = () => {
    const div = document.createElement('div');
    div.innerHTML = '<textarea></textarea><input type="checkbox" /><button>b</button>';
    document.body.append(div);
    return div;
  };
  it('selection wins only for a text field holding text', () => {
    const div = host();
    const area = div.querySelector('textarea')!;
    expect(selectionWins(area, div)).toBe(false);
    area.value = 'hello';
    expect(selectionWins(area, div)).toBe(true);
    expect(selectionWins(div.querySelector('input')!, div)).toBe(false);
    expect(selectionWins(div.querySelector('button')!, div)).toBe(false);
    div.remove();
  });
  it('touch: the scroller keeps a vertical pan until its limit; sideways always stretches', () => {
    const surface = document.createElement('div');
    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    surface.append(list);
    document.body.append(surface);
    Object.defineProperties(list, {
      scrollHeight: { value: 500, configurable: true },
      clientHeight: { value: 100, configurable: true },
    });
    list.scrollTop = 0;
    expect(scrollerTakesMove(list, surface, 0, 10)).toBe(false); // pulling down at the top limit
    expect(scrollerTakesMove(list, surface, 0, -10)).toBe(true); // can still scroll down
    expect(scrollerTakesMove(list, surface, 30, 2)).toBe(false); // sideways
    surface.remove();
  });
});

describe('GlassSurface press (DOM)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    for (const prop of ['offsetWidth', 'offsetHeight'] as const)
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => (prop === 'offsetWidth' ? 200 : 100) });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  });
  const pointer = (type: string, x: number, y: number, target: EventTarget = window) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    target.dispatchEvent(event);
  };
  const mount = (onClick: () => void) =>
    act(() => {
      root.render(
        <GlassSurface>
          <button type="button" onClick={onClick}>Go</button>
        </GlassSurface>,
      );
    });

  // Trusted clicks can't be faked here: the swallow itself is covered by stretch.pw.ts.
  it('a press with no real movement still clicks, even with a little jitter', () => {
    const onClick = vi.fn();
    mount(onClick);
    const button = container.querySelector('button')!;
    pointer('pointerdown', 50, 50, button);
    pointer('pointermove', 50 + PULL_ENGAGE_PX + 1, 50);
    pointer('pointerup', 50 + PULL_ENGAGE_PX + 1, 50);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('lets synthetic clicks through after a pull (dropdown drag-select)', () => {
    const onClick = vi.fn();
    mount(onClick);
    const button = container.querySelector('button')!;
    pointer('pointerdown', 50, 50, button);
    pointer('pointermove', 90, 50);
    pointer('pointerup', 90, 50);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('is off under prefers-reduced-motion', () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const onClick = vi.fn();
    mount(onClick);
    const button = container.querySelector('button')!;
    const surface = container.querySelector<HTMLElement>('[data-glass-surface]')!;
    pointer('pointerdown', 50, 50, button);
    pointer('pointermove', 120, 50);
    expect(surface.dataset.stretching).toBeUndefined();
    pointer('pointerup', 120, 50);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('the nearest surface owns the pull', () => {
    act(() => {
      root.render(
        <GlassSurface data-testid="outer">
          <GlassSurface data-testid="inner">
            <button type="button">Go</button>
          </GlassSurface>
        </GlassSurface>,
      );
    });
    pointer('pointerdown', 50, 50, container.querySelector('button')!);
    pointer('pointermove', 120, 50);
    expect(container.querySelector<HTMLElement>('[data-testid="inner"]')!.dataset.stretching).toBe('true');
    expect(container.querySelector<HTMLElement>('[data-testid="outer"]')!.dataset.stretching).toBeUndefined();
    pointer('pointerup', 120, 50);
  });
  it('a press that opens a menu belongs to the menu', () => {
    act(() => {
      root.render(
        <GlassSurface data-testid="outer">
          <button type="button" data-press-opens="">Menu</button>
        </GlassSurface>,
      );
    });
    pointer('pointerdown', 50, 50, container.querySelector('button')!);
    pointer('pointermove', 120, 50);
    expect(container.querySelector<HTMLElement>('[data-testid="outer"]')!.dataset.stretching).toBeUndefined();
    pointer('pointerup', 120, 50);
  });
  it('a fade never lands on the root as opacity: that would blank the lens', () => {
    act(() => {
      root.render(<GlassSurface data-testid="faded" initial={{ opacity: 0 }} animate={{ opacity: 0 }} />);
    });
    const surface = container.querySelector<HTMLElement>('[data-testid="faded"]')!;
    expect(surface.style.opacity).toBe('');
  });
});
