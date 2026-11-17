import {expect} from '@playwright/test';
import { openSignedInPage, signedInTest as test } from './sign-in';

test.use({serviceWorkers: 'block'});

test('defect 1: composer and EmptyState clear before the flight first renders', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSignedInPage(page);
  await expect(page.getByTestId('chat-empty-state')).toBeVisible();

  const input = page.getByTestId('composer-input');
  await input.fill('Lift immediately on frame one');
  const fromRect = await input.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, width: r.width };
  });

  await page.evaluate(() => {
    const w = window as unknown as {
      __entered: boolean;
      __frames: Array<{
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
    w.__entered = false;
    const inputEl = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
    inputEl?.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') w.__entered = true;
      },
      { once: true },
    );
    const sample = () => {
      if (w.__stopFrames || !w.__entered) return;
      const curInput = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
      const flight = document.querySelector<HTMLElement>('[data-testid="send-flight-bubble"]');
      if (!flight) return;
      const rect = flight.getBoundingClientRect();
      w.__frames.push({
        inputVal: curInput?.value ?? '',
        emptyPresent: !!document.querySelector('[data-testid="chat-empty-state"]'),
        flightTop: rect.top, flightWidth: rect.width,
        fillOpacity: Number(getComputedStyle(flight).getPropertyValue('--send-fill-opacity') || '1'),
      });
    };
    new MutationObserver(sample).observe(document.body, {subtree: true, childList: true,
      attributes: true, attributeFilter: ['style']});
  });

  await input.press('Enter');
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  const frames = await page.evaluate(() => {
    const w = window as unknown as {
      __frames: Array<{
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
  expect(firstFrame.inputVal).toBe('');
  expect(firstFrame.emptyPresent).toBe(false);
  expect(firstFrame.flightTop).not.toBeNull();
  expect(firstFrame.fillOpacity ?? 0).toBeGreaterThanOrEqual(0.55);

  const lifted = frames.find(frame => frame.flightTop !== null && frame.flightTop < fromRect.top - 0.1);
  expect(lifted).toBeDefined();
  expect(lifted!.flightTop!).toBeLessThan(fromRect.top - 0.1);
  expect(lifted!.flightWidth!).toBeLessThan(fromRect.width - 0.1);
});

test('defect 2: instant scripted reply never paints before the 820ms bubble flight lands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSignedInPage(page);

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
