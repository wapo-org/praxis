import { expect, type Locator, type Page } from '@playwright/test';
import { MORPH } from '../../../packages/glass/src/motion';

/** Morph time at a frame's rAF timestamp, in ms; the same value for every sampler in that frame. */
export type MorphTime = (now: number) => number;
export type MorphClockWindow = Window & { __morphTime: MorphTime };

/** Springs advance at most `maxFrameSeconds` a frame, so a busy host slows the morph; time samples on the springs' clock. */
export async function installMorphClock(page: Page): Promise<void> {
  await page.addInitScript((capMs: number) => {
    let last = performance.now();
    let time = 0;
    (window as unknown as MorphClockWindow).__morphTime = (now: number) => {
      if (now > last) {
        time += Math.min(now - last, capMs);
        last = now;
      }
      return time;
    };
  }, MORPH.maxFrameSeconds * 1000);
}

/** An unpositioned shell is hidden with no transform too: visible proves the morph began, no `data-morphing` that it ended. */
export async function landed(shell: Locator): Promise<void> {
  await expect
    .poll(() => shell.evaluate((el: HTMLElement) => el.style.visibility !== 'hidden' && el.style.transform === '' && !el.querySelector('[data-morphing]')), {
      timeout: 10000,
    })
    .toBe(true);
}
