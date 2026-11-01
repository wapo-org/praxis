// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GlassChip } from '../primitives';
import { afterEach, expect, it, vi } from 'vitest';
import { negotiateStrategy } from '../engine-detect';
import { MATERIAL_PARAMS, REFERENCE_PARAMS } from './params';
import { backdropRoot } from './backdrop';
import { GlassWebGLRuntime } from './runtime';
const render = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());
const destroy = vi.hoisted(() => vi.fn());
const renderer = vi.hoisted(() =>
  vi.fn(function () {
    return { render, upload, destroy };
  }),
);
vi.mock('./renderer', () => ({ RefractionRenderer: renderer }));
// jsdom has no 2D canvas; the runtime's scheduling is under test, not the painter.
vi.mock('./backdrop', async (original) => ({ ...(await original<typeof import('./backdrop')>()), paintBackdrop: vi.fn() }));
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  render.mockClear();
  renderer.mockClear();
});
it('keeps source regular material parameters and thickness ramp', () => {
  expect(MATERIAL_PARAMS.regular).toEqual(REFERENCE_PARAMS);
  expect(REFERENCE_PARAMS).toMatchObject({ thickness: 50, ior: 3, bezel: 60 });
  expect(MATERIAL_PARAMS.thin.thickness).toBeLessThan(MATERIAL_PARAMS.regular.thickness);
});
it('negotiates WebGL on WebKit and Firefox, SVG on Chromium, opaque on reduced transparency', () => {
  vi.stubGlobal('WebGLRenderingContext', function () {});
  vi.stubGlobal('CSS', { supports: () => true });
  for (const ua of ['Version/18.0 Safari/605.1.15', 'Firefox/150']) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    expect(negotiateStrategy()).toBe('webgl-refraction');
  }
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/140 Safari/537.36');
  expect(negotiateStrategy()).toBe('svg-displacement');
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  expect(negotiateStrategy()).toBe('reduced-transparency');
});
it('chooses the parent surface for nested dropdowns and document for top-level glass', () => {
  const parent = document.createElement('div'),
    child = document.createElement('div');
  parent.dataset.glassSurface = '';
  parent.append(child);
  document.body.append(parent);
  expect(backdropRoot(child)).toBe(parent);
  expect(backdropRoot(parent)).toBe(document.body);
});
it('does not allocate or draw invisible/hidden surfaces; disconnects on destroy', () => {
  let intersect!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: IntersectionObserverCallback) {
        intersect = cb;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  let callback: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const runtime = new GlassWebGLRuntime(vi.fn());
  const el = document.createElement('div');
  document.body.append(el);
  runtime.add(el, document.createElement('canvas'), {
    radius: 20,
    material: 'regular',
    intensity: 'medium',
    frost: 'none',
    rim: 1,
  });
  callback?.(0);
  expect(renderer).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  intersect(
    [{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  callback?.(1);
  expect(renderer).not.toHaveBeenCalled();
  runtime.destroy();
  expect(disconnect).toHaveBeenCalledTimes(2);
});

it("leaves chip foreground transparent so the material remains visible", () => {
  const root=document.createElement("div");root.innerHTML=renderToStaticMarkup(React.createElement(GlassChip,null,"Chip"));
  expect((root.querySelector(".praxis-glass-chip") as HTMLElement).style.background).toBe("transparent");
});

function stubObservers() {
  let intersect!: IntersectionObserverCallback;
  let mutate!: MutationCallback;
  vi.stubGlobal('IntersectionObserver', class { constructor(cb: IntersectionObserverCallback) { intersect = cb; } observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('MutationObserver', class { constructor(cb: MutationCallback) { mutate = cb; } observe() {} disconnect() {} });
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const flush = () => { for (const cb of frames.splice(0)) cb(0); };
  return { intersect: (el: Element) => intersect([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver), mutate: (records: Partial<MutationRecord>[]) => mutate(records as MutationRecord[], {} as MutationObserver), frames, flush };
}
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
const params = { radius: 20, material: 'regular', intensity: 'medium', frost: 'none', rim: 1 } as const;

it('WP-W3: re-negotiates refraction when a lost context is restored', () => {
  const o = stubObservers();
  const glCanvas = document.createElement('canvas');
  let lost!: () => void;
  renderer.mockImplementationOnce(function (onLost: () => void) { lost = onLost; return { render, upload, destroy, canvas: glCanvas }; } as never);
  const failed = vi.fn(), restored = vi.fn();
  const runtime = new GlassWebGLRuntime(failed, restored);
  const el = document.createElement('div');
  document.body.append(el);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 100, 100));
  runtime.add(el, document.createElement('canvas'), params);
  o.intersect(el);
  o.flush();
  lost();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(restored).not.toHaveBeenCalled();
  glCanvas.dispatchEvent(new Event('webglcontextrestored'));
  expect(restored).toHaveBeenCalledTimes(1);
  runtime.destroy();
});

it('WP-W3: recaptures only for mutations behind a visible surface, at most every 100 ms', () => {
  vi.useFakeTimers();
  const o = stubObservers();
  const runtime = new GlassWebGLRuntime(vi.fn());
  const el = document.createElement('div'), behind = document.createElement('p'), away = document.createElement('p');
  document.body.append(el, behind, away);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 100, 100));
  vi.spyOn(behind, 'getBoundingClientRect').mockReturnValue(rect(10, 10, 50, 20));
  vi.spyOn(away, 'getBoundingClientRect').mockReturnValue(rect(500, 500, 50, 20));
  runtime.add(el, document.createElement('canvas'), params);
  o.intersect(el);
  o.flush();
  o.mutate([{ target: away }]);
  expect(o.frames).toHaveLength(0); // nothing behind the glass changed
  o.mutate([{ target: behind }]);
  expect(o.frames).toHaveLength(1);
  o.flush();
  for (let i = 0; i < 10; i++) o.mutate([{ target: behind }]); // a burst (e.g. streaming tokens)
  expect(o.frames).toHaveLength(0);
  vi.advanceTimersByTime(100);
  expect(o.frames).toHaveLength(1); // coalesced into one recapture
  runtime.destroy();
  vi.useRealTimers();
});
