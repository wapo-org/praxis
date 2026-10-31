// @vitest-environment jsdom
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
