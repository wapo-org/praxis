import type { Locator, Page } from '@playwright/test';

type Edges = { t: number; l: number; r: number; top: number; b: number };
export const startSampling = (surface: Locator) =>
  surface.evaluate((el) => {
    const w = window as unknown as { __s: Edges[]; __on: boolean };
    w.__s = [];
    w.__on = true;
    const tick = () => {
      if (!w.__on) return;
      const r = el.getBoundingClientRect();
      w.__s.push({ t: performance.now(), l: r.left, r: r.right, top: r.top, b: r.bottom });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
export const stopSampling = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __s: Edges[]; __on: boolean };
    w.__on = false;
    return w.__s;
  });
