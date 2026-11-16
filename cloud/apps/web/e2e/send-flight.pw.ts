import {expect, test} from '@playwright/test';
import {signIn} from './sign-in';

test.use({serviceWorkers: 'block'});

test('defect 1: text leaves composer, EmptyState exits, and bubble starts lifting on the first frame after Enter', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await expect(page.getByTestId('chat-empty-state')).toBeVisible();

  const input = page.getByTestId('composer-input');
  await input.fill('Lift immediately on frame one');
  const fromRect = await input.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, width: r.width };
  });

  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  await page.evaluate(() => {
    const w = window as unknown as {
      __enterAt: number;
      __frames: Array<{
        dt: number;
        inputVal: string;
        emptyPresent: boolean;
        flightTop: number | null;
        flightWidth: number | null;
        fillOpacity: number | null;
      }>;
      __stopFrames: boolean;
    };
    w.__frames = [];
    w.__stopFrames = false;
    w.__enterAt = 0;
    const inputEl = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
    inputEl?.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') w.__enterAt = performance.now();
      },
      { once: true },
    );
    const tick = () => {
      if (w.__stopFrames) return;
      if (w.__enterAt > 0) {
        const curInput = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
        const flight = document.querySelector<HTMLElement>('[data-testid="send-flight-bubble"]');
        const empty = document.querySelector('[data-testid="chat-empty-state"]');
        const fRect = flight?.getBoundingClientRect();
        w.__frames.push({
          dt: performance.now() - w.__enterAt,
          inputVal: curInput?.value ?? '',
          emptyPresent: !!empty,
          flightTop: fRect ? fRect.top : null,
          flightWidth: fRect ? fRect.width : null,
          fillOpacity: flight ? Number(getComputedStyle(flight).getPropertyValue('--send-fill-opacity') || '1') : null,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await input.press('Enter');
  await page.clock.runFor(45);
  await page.clock.resume();
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  const frames = await page.evaluate(() => {
    const w = window as unknown as {
      __frames: Array<{
        dt: number;
        inputVal: string;
        emptyPresent: boolean;
        flightTop: number | null;
        flightWidth: number | null;
        fillOpacity: number | null;
      }>;
      __stopFrames: boolean;
    };
    w.__stopFrames = true;
    return w.__frames;
  });

  const firstFrame = frames[0]!;
  expect(firstFrame).toBeDefined();
  expect(firstFrame.dt).toBeLessThanOrEqual(40);
  expect(firstFrame.inputVal).toBe('');
  expect(firstFrame.emptyPresent).toBe(false);
  expect(firstFrame.flightTop).not.toBeNull();
  expect(firstFrame.fillOpacity ?? 0).toBeGreaterThanOrEqual(0.55);

  const at35ms = frames.find((f) => f.dt >= 12 && f.flightTop !== null);
  expect(at35ms).toBeDefined();
  expect(at35ms!.dt).toBeLessThanOrEqual(45);
  expect(at35ms!.flightTop!).toBeLessThan(fromRect.top - 0.1);
  expect(at35ms!.flightWidth!).toBeLessThan(fromRect.width - 0.1);
});

test('defect 2: instant scripted reply never paints before the 820ms bubble flight lands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);

  await page.evaluate(() => {
    const w = window as unknown as {
      __d2Frames: Array<{
        hasFlight: boolean;
        liveCount: number;
        assistantCount: number;
      }>;
      __d2Stop: boolean;
    };
    w.__d2Frames = [];
    w.__d2Stop = false;
    const tick = () => {
      if (w.__d2Stop) return;
      const hasFlight = !!document.querySelector('[data-testid="send-flight-bubble"]');
      const liveCount = document.querySelectorAll('[data-testid="live-run-streaming-turn"]').length;
      const assistantCount = document.querySelectorAll('[data-testid="assistant-turn"]').length;
      if (hasFlight || liveCount > 0 || assistantCount > 0) {
        w.__d2Frames.push({ hasFlight, liveCount, assistantCount });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const input = page.getByTestId('composer-input');
  await input.fill('Instant scripted answer test');
  await input.press('Enter');

  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  const frames = await page.evaluate(() => {
    const w = window as unknown as {
      __d2Frames: Array<{ hasFlight: boolean; liveCount: number; assistantCount: number }>;
      __d2Stop: boolean;
    };
    w.__d2Stop = true;
    return w.__d2Frames;
  });

  const flightFrames = frames.filter((f) => f.hasFlight);
  expect(flightFrames.length).toBeGreaterThan(0);
  // Zero assistant or live turns may be painted while the bubble is in flight.
  expect(flightFrames.filter((f) => f.liveCount > 0 || f.assistantCount > 0)).toEqual([]);

  const userBox = await page.getByTestId('user-message-bubble').boundingBox();
  const assistantBox = await page.getByTestId('assistant-turn').boundingBox();
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(assistantBox!.y).toBeGreaterThanOrEqual(userBox!.y + userBox!.height);
});
