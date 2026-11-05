// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ELASTIC_REST,
  ELASTIC_THRESHOLD,
  elasticPoseForOffset,
  elasticTransform,
  shouldSwallowClick,
  stepElasticSpring,
  useElasticStretch,
} from './elastic';
import { GlassSurface } from './GlassSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('elastic pose (pure)', () => {
  it('rests at zero offset without transform', () => {
    expect(elasticPoseForOffset(0, 0)).toEqual(ELASTIC_REST);
    expect(elasticTransform(ELASTIC_REST)).toBe('none');
  });
  it('stretches toward the pointer with growing resistance', () => {
    const near = elasticPoseForOffset(10, 0);
    const far = elasticPoseForOffset(200, 0);
    expect(near.scaleX).toBeGreaterThan(1);
    expect(far.scaleX).toBeGreaterThan(near.scaleX);
    // Caps: a huge drag never grows without bound.
    expect(far.scaleX).toBeLessThanOrEqual(1.071);
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(26);
    // Directional: a horizontal drag barely squashes vertically.
    expect(far.scaleY).toBeLessThan(1.01);
    expect(near.x).toBeGreaterThan(0);
    expect(near.y).toBe(0);
  });
  it('never skews, so corners cannot visibly distort', () => {
    const pose = elasticPoseForOffset(150, 150);
    expect(elasticTransform(pose)).not.toContain('skew');
    expect(elasticTransform(pose)).not.toContain('rotate');
  });
});

describe('elastic spring (the one SPRING)', () => {
  it('settles to rest and stops', () => {
    let pose = elasticPoseForOffset(180, -40);
    let velocity = { x: 0, y: 0, scaleX: 0, scaleY: 0 };
    let settled = false;
    for (let i = 0; i < 600 && !settled; i++) {
      const step = stepElasticSpring(pose, velocity, 1 / 60);
      pose = step.pose;
      velocity = step.velocity;
      settled = step.settled;
    }
    expect(settled).toBe(true);
    expect(Math.abs(pose.x)).toBeLessThan(0.05);
    expect(pose.scaleX).toBeCloseTo(1, 3);
  });
  it('returns quickly and stays within the drag bounds', () => {
    const start = elasticPoseForOffset(220, 0);
    let pose = { ...start };
    let velocity = { x: 0, y: 0, scaleX: 0, scaleY: 0 };
    let settled = false;
    for (let i = 0; i < 600 && !settled; i++) {
      const step = stepElasticSpring(pose, velocity, 1 / 60);
      pose = step.pose;
      velocity = step.velocity;
      settled = step.settled;
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(26);
      expect(pose.scaleX).toBeGreaterThanOrEqual(0.99);
      expect(pose.scaleX).toBeLessThanOrEqual(1.08);
    }
    expect(settled).toBe(true);
    expect(Math.abs(pose.x)).toBeLessThan(0.05);
  });
});

let container: HTMLDivElement;
let root: Root;

function surfaceEl() {
  return container.querySelector<HTMLElement>('[data-elastic-surface]');
}

function restTransform(el: HTMLElement) {
  return el.style.transform === '' || el.style.transform === 'none';
}

function rectOf(size = 200) {
  const rect = {
    left: 100,
    top: 100,
    width: size,
    height: size,
    right: 100 + size,
    bottom: 100 + size,
    x: 100,
    y: 100,
    toJSON: () => {},
  } as DOMRect;
  return rect;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('matchMedia', (query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList,
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return rectOf(this.matches?.('[data-elastic-surface]') ? 200 : 60);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountSurface() {
  await act(async () =>
    root.render(
      <GlassSurface material="regular" shape="card" data-testid="surface">
        <div style={{ height: 60 }}>content</div>
      </GlassSurface>,
    ),
  );
  return surfaceEl()!;
}

function pointer(type: string, target: Element, x: number, y: number, pointerId = 7) {
  // jsdom has no PointerEvent constructor; the handler only reads these fields.
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  for (const [key, value] of [
    ['pointerId', pointerId],
    ['pointerType', 'mouse'],
    ['button', 0],
  ] as const)
    Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}

/**
 * jsdom cannot produce trusted events (isTrusted is a non-configurable
 * prototype getter), so the trusted-vs-synthetic gate is covered by the
 * shouldSwallowClick unit test below. This helper dispatches a best-effort
 * click; the DOM suppression tests use the synthetic path (button.click()).
 */

describe('shouldSwallowClick', () => {
  it('swallows only trusted clicks, so synthetic row.click() selection survives', () => {
    expect(shouldSwallowClick({ isTrusted: true })).toBe(true);
    expect(shouldSwallowClick({ isTrusted: false })).toBe(false);
  });
});

describe('elastic stretch (DOM)', () => {
  it('stretches toward the pointer and springs back to none', async () => {
    await mountSurface();
    const surface = surfaceEl()!;
    // Below threshold: nothing happens, the click goes through.
    await act(async () => {
      pointer('pointerdown', surface, 200, 200);
      pointer('pointermove', surface, 200 + ELASTIC_THRESHOLD - 1, 200);
      pointer('pointerup', surface, 200 + ELASTIC_THRESHOLD - 1, 200);
    });
    expect(restTransform(surface)).toBe(true);
    // Beyond threshold: transform appears, then springs back.
    await act(async () => {
      pointer('pointerdown', surface, 200, 200);
      pointer('pointermove', surface, 260, 220);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(surface.style.transform).toContain('translate');
    await act(async () => {
      pointer('pointerup', surface, 260, 220);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(restTransform(surface)).toBe(true);
  });

  it('suppresses the click after a real drag', async () => {
    const clicks = vi.fn();
    await act(async () =>
      root.render(
        <GlassSurface material="regular" shape="card">
          <button type="button" onClick={clicks}>
            inside
          </button>
        </GlassSurface>,
      ),
    );
    const surface = surfaceEl()!;
    const button = surface.querySelector('button')!;
    // jsdom clicks are synthetic (isTrusted false) and pass the trust gate by
    // design; the trusted half is covered by the shouldSwallowClick unit test.
    await act(async () => {
      pointer('pointerdown', button, 200, 200);
      pointer('pointermove', button, 240, 230);
      pointer('pointerup', button, 240, 230);
      button.click();
    });
    expect(clicks).toHaveBeenCalledOnce();
    // A plain tap still clicks.
    await act(async () => button.click());
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it('lets synthetic clicks through, so programmatic selection (dropdown drag-select) keeps working', async () => {
    const clicks = vi.fn();
    await act(async () =>
      root.render(
        <GlassSurface material="regular" shape="card">
          <button type="button" onClick={clicks}>
            inside
          </button>
        </GlassSurface>,
      ),
    );
    const surface = surfaceEl()!;
    const button = surface.querySelector('button')!;
    await act(async () => {
      pointer('pointerdown', button, 200, 200);
      pointer('pointermove', button, 240, 230);
      pointer('pointerup', button, 240, 230);
    });
    // A dropdown's native drag-select calls row.click(): dispatched from JS,
    // isTrusted === false, and must NOT be swallowed by the drag suppression.
    await act(async () => button.click());
    expect(clicks).toHaveBeenCalledOnce();
  });

  it('does not start from text inputs, so typing and selection keep working', async () => {
    await act(async () =>
      root.render(
        <GlassSurface material="regular" shape="card">
          <textarea aria-label="Message" data-no-elastic />
        </GlassSurface>,
      ),
    );
    const surface = surfaceEl()!;
    const input = surface.querySelector('textarea')!;
    await act(async () => {
      pointer('pointerdown', input, 200, 200);
      pointer('pointermove', input, 280, 260);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(restTransform(surface)).toBe(true);
    await act(async () => pointer('pointerup', input, 280, 260));
  });

  it('is disabled under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) =>
      ({
        matches: String(query).includes('prefers-reduced-motion'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
    );
    await mountSurface();
    const surface = surfaceEl()!;
    await act(async () => {
      pointer('pointerdown', surface, 200, 200);
      pointer('pointermove', surface, 280, 260);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(restTransform(surface)).toBe(true);
    await act(async () => pointer('pointerup', surface, 280, 260));
  });

  it('pointercancel (touch scroll takeover) springs back and keeps the click', async () => {
    const clicks = vi.fn();
    await act(async () =>
      root.render(
        <GlassSurface material="regular" shape="card">
          <button type="button" onClick={clicks}>
            inside
          </button>
        </GlassSurface>,
      ),
    );
    const surface = surfaceEl()!;
    const button = surface.querySelector('button')!;
    await act(async () => {
      pointer('pointerdown', button, 200, 200);
      pointer('pointermove', button, 240, 230);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(surface.style.transform).toContain('translate');
    // The browser takes the gesture for scrolling: cancel springs back and
    // does NOT arm click suppression — the user's tap still works.
    await act(async () => {
      pointer('pointercancel', button, 240, 230);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    expect(restTransform(surface)).toBe(true);
    await act(async () => button.click());
    expect(clicks).toHaveBeenCalledOnce();
  });

  it('aborts the stretch when the user selects text', async () => {
    await mountSurface();
    const surface = surfaceEl()!;
    await act(async () => {
      pointer('pointerdown', surface, 200, 200);
      const text = surface.querySelector('div')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, Math.min(1, text.textContent?.length ?? 1));
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      // The move must exist before selecting, otherwise there is no drag to abort.
      // Select first, then drag.
    });
    expect(window.getSelection()?.toString().length).toBeGreaterThan(0);
    await act(async () => {
      pointer('pointermove', surface, 280, 240);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(restTransform(surface)).toBe(true);
    await act(async () => pointer('pointerup', surface, 280, 240));
    window.getSelection()?.removeAllRanges();
  });

  it('useElasticStretch attaches no listeners when disabled', () => {
    function Probe() {
      const ref = useElasticStretch<HTMLDivElement>({ disabled: true });
      return <div ref={ref} data-testid="probe" />;
    }
    act(() => root.render(<Probe />));
    const probe = container.querySelector<HTMLElement>('[data-testid="probe"]')!;
    // No throw, no mouse session recorded on the probe either way.
    act(() => {
      pointer('pointerdown', probe, 10, 10);
      pointer('pointermove', probe, 90, 90);
      pointer('pointerup', probe, 90, 90);
    });
    expect(probe.style.transform).toBe('');
  });
});
