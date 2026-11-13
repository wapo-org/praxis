import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function signIn(page: Page, path = '/') {
  await page.goto(path);
  const dev = page.getByRole('button', { name: /local dev user/i });
  await Promise.race([dev.waitFor(), page.getByTestId('chat-top-bar').waitFor()]);
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByTestId('chat-top-bar').waitFor();
}

test('empty-state send clears EmptyState on frame 1, avoids 404s, and renders a single bubble', async ({ page }) => {
  const notFoundUrls: string[] = [];
  page.on('response', (res) => {
    if (res.status() === 404 && res.url().includes('/v1/')) {
      notFoundUrls.push(res.url());
    }
  });

  await signIn(page);
  await expect(page.getByTestId('chat-empty-state')).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as {
      __checks: Array<{ emptyVisible: boolean; bubbleCount: number }>;
      __stop: boolean;
    };
    w.__checks = [];
    w.__stop = false;
    const tick = () => {
      if (w.__stop) return;
      const empty = document.querySelector('[data-testid="chat-empty-state"]');
      const flight = document.querySelector('[data-testid="send-flight-bubble"]');
      const bubbles = document.querySelectorAll('[data-testid="user-message-bubble"] [data-user-bubble]');
      if (flight || bubbles.length > 0) {
        w.__checks.push({
          emptyVisible: !!empty && getComputedStyle(empty).opacity !== '0',
          bubbleCount: bubbles.length,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const input = page.getByTestId('composer-input');
  await input.fill(`Empty state send ${Date.now()}`);
  await input.press('Enter');

  // Empty state must be gone immediately, with no 404 on /messages while creating chat.
  await expect(page.getByTestId('chat-empty-state')).toHaveCount(0);
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });
  const checks = await page.evaluate(() => {
    const w = window as unknown as {
      __checks: Array<{ emptyVisible: boolean; bubbleCount: number }>;
      __stop: boolean;
    };
    w.__stop = true;
    return w.__checks;
  });

  expect(checks.length).toBeGreaterThan(2);
  expect(checks.filter((c) => c.emptyVisible)).toHaveLength(0);
  expect(notFoundUrls).toEqual([]);
  await expect(page.getByTestId('user-message-bubble')).toHaveCount(1);
});

test('Working · 0s, Stop generating, and RunBackdrop appear immediately even when server start is delayed, and Stop works while queued', async ({ page }) => {
  await signIn(page);

  let releaseRunPost!: () => void;
  const runPostHeld = new Promise<void>((r) => {
    releaseRunPost = r;
  });
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await runPostHeld;
    const body = route.request().postDataJSON();
    await route.continue({
      postData: JSON.stringify({ ...body, providerId: 'scripted', modelId: 'scripted', script: 'long' }),
    });
  });

  const input = page.getByTestId('composer-input');
  await input.fill('Wait on queued start');
  await input.press('Enter');

  // Stop & RunBackdrop appear immediately; Working · 0s appears once the bubble lands (< 500ms).
  await expect(page.getByTestId('composer-stop-button')).toBeVisible({ timeout: 500 });
  await expect(page.getByTestId('run-backdrop')).toBeAttached({ timeout: 500 });
  await expect(page.getByTestId('live-run-streaming-turn')).toContainText('Working', { timeout: 500 });

  // Cancel while still queued on the client before POST /v1/runs returns.
  await page.getByTestId('composer-stop-button').click();
  await expect(page.getByTestId('composer-stop-button')).toHaveCount(0);

  // Release POST /v1/runs and verify it does not resurrect the cancelled run.
  releaseRunPost();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('composer-stop-button')).toHaveCount(0);
});

test('existing-chat send flies smoothly without losing or duplicating the bubble', async ({ page }) => {
  await signIn(page);

  const input = page.getByTestId('composer-input');
  await input.fill('First turn in chat');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  await input.fill('Second turn in existing chat');
  await page.evaluate(() => {
    const w = window as unknown as { __flightSamples: Array<{ t: number; y: number }>; __go: boolean };
    w.__flightSamples = [];
    w.__go = true;
    const tick = () => {
      if (!w.__go) return;
      const flight = document.querySelector<HTMLElement>('[data-testid="send-flight-bubble"]');
      if (flight) w.__flightSamples.push({ t: performance.now(), y: flight.getBoundingClientRect().top });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await input.press('Enter');
  await expect(page.getByTestId('assistant-turn')).toHaveCount(2, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  const samples = await page.evaluate(() => {
    const w = window as unknown as { __flightSamples: Array<{ t: number; y: number }>; __go: boolean };
    w.__go = false;
    return w.__flightSamples;
  });
  expect(samples.length).toBeGreaterThan(3);
  const maxNormStep = Math.max(
    0,
    ...samples.slice(1).map((s, i) => {
      const prev = samples[i]!;
      const dt = Math.max(16.67, s.t - prev.t);
      return Math.abs(s.y - prev.y) * (16.67 / dt);
    }),
  );
  expect(maxNormStep).toBeLessThanOrEqual(120);
  // Flight must never snap down sharply (> 12px) after moving upward.
  const downwardSnaps = samples.slice(1).filter((s, i) => s.y - samples[i]!.y > 12);
  expect(downwardSnaps).toEqual([]);
  await expect(page.getByTestId('user-message-bubble')).toHaveCount(2);
  await expect(page.locator('[data-user-bubble]').last()).toHaveCSS('opacity', '1');
});

test('defect 1: text leaves composer, EmptyState exits, and bubble starts lifting on the first frame after Enter', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);
  await expect(page.getByTestId('chat-empty-state')).toBeVisible();

  const input = page.getByTestId('composer-input');
  await input.fill('Lift immediately on frame one');
  const fromRect = await input.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, width: r.width };
  });

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
  expect(at35ms!.flightTop!).toBeLessThan(fromRect.top - 25);
  expect(at35ms!.flightWidth!).toBeLessThan(fromRect.width - 20);
});

test('defect 2: instant scripted reply never paints before the <= 250ms bubble flight lands', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);

  await page.evaluate(() => {
    const w = window as unknown as {
      __d2Frames: Array<{
        t: number;
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
        w.__d2Frames.push({ t: performance.now(), hasFlight, liveCount, assistantCount });
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
      __d2Frames: Array<{ t: number; hasFlight: boolean; liveCount: number; assistantCount: number }>;
      __d2Stop: boolean;
    };
    w.__d2Stop = true;
    return w.__d2Frames;
  });

  const flightFrames = frames.filter((f) => f.hasFlight);
  expect(flightFrames.length).toBeGreaterThan(2);
  const flightDuration = flightFrames.at(-1)!.t - flightFrames[0]!.t;
  expect(flightDuration).toBeLessThanOrEqual(260);
  // Zero assistant or live turns may be painted while the bubble is in flight.
  expect(flightFrames.filter((f) => f.liveCount > 0 || f.assistantCount > 0)).toEqual([]);

  const userBox = await page.getByTestId('user-message-bubble').boundingBox();
  const assistantBox = await page.getByTestId('assistant-turn').boundingBox();
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(assistantBox!.y).toBeGreaterThanOrEqual(userBox!.y + userBox!.height);
});

test('defect 3: text-only turns show no work group or usage flash and keep reply y invariant across live-to-saved swap', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);

  // 1) Instant scripted text-only turn: no work group and no usage line at any frame.
  await page.evaluate(() => {
    const w = window as unknown as {
      __d3InstantBad: string[];
      __d3Stop: boolean;
    };
    w.__d3InstantBad = [];
    w.__d3Stop = false;
    const tick = () => {
      if (w.__d3Stop) return;
      if (document.querySelectorAll('[data-testid="agent-activity-view"]').length > 0) {
        w.__d3InstantBad.push('agent-activity-view');
      }
      const text = document.querySelector('[data-chat-column]')?.textContent ?? '';
      if (/\d+\s+in\s*·\s*\d+\s+out/.test(text) || /Worked for/.test(text)) {
        w.__d3InstantBad.push(text);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const input = page.getByTestId('composer-input');
  await input.fill('Text only instant turn');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForTimeout(500);
  const instantBad = await page.evaluate(() => {
    const w = window as unknown as { __d3InstantBad: string[]; __d3Stop: boolean };
    w.__d3Stop = true;
    return w.__d3InstantBad;
  });
  expect(instantBad).toEqual([]);

  // 2) Streaming text-only turn crossing live -> completed -> saved swap:
  // start a fresh chat so nothing scrolls, force token-paced streaming without reasoning/tools.
  await page.getByTestId('sidebar-new-chat').click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    await route.continue({
      postData: JSON.stringify({
        ...body,
        providerId: 'scripted',
        modelId: 'scripted',
        script: 'streamSim',
        streamSim: { sample: 'short', reasoningShape: 'none', chunkSize: 'char', speed: 'jitter' },
      }),
    });
  });

  await page.evaluate(() => {
    const w = window as unknown as {
      __swapSamples: Array<{
        kind: 'live' | 'saved';
        textTop: number;
        activityCount: number;
        hasUsage: boolean;
      }>;
      __swapStop: boolean;
    };
    w.__swapSamples = [];
    w.__swapStop = false;
    const tick = () => {
      if (w.__swapStop) return;
      const liveTurn = document.querySelector('[data-testid="live-run-streaming-turn"]');
      const savedTurn = document.querySelector('[data-testid="assistant-turn"]');
      const activeTurn = liveTurn ?? savedTurn;
      const textEl = activeTurn?.querySelector<HTMLElement>('[data-timeline-text]');
      if (activeTurn && textEl) {
        const colText = activeTurn.textContent ?? '';
        w.__swapSamples.push({
          kind: liveTurn ? 'live' : 'saved',
          textTop: textEl.getBoundingClientRect().top,
          activityCount: document.querySelectorAll('[data-testid="agent-activity-view"]').length,
          hasUsage: /\d+\s+in\s*·\s*\d+\s+out/.test(colText),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await input.fill('Streaming text-only swap check');
  await input.press('Enter');
  await expect(page.getByTestId('assistant-turn')).toHaveCount(1, { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });

  const swapSamples = await page.evaluate(() => {
    const w = window as unknown as {
      __swapSamples: Array<{ kind: 'live' | 'saved'; textTop: number; activityCount: number; hasUsage: boolean }>;
      __swapStop: boolean;
    };
    w.__swapStop = true;
    return w.__swapSamples;
  });

  expect(swapSamples.some((s) => s.kind === 'live')).toBe(true);
  expect(swapSamples.some((s) => s.kind === 'saved')).toBe(true);
  expect(swapSamples.filter((s) => s.activityCount > 0 || s.hasUsage)).toEqual([]);
  const liveSamples = swapSamples.filter((s) => s.kind === 'live');
  const savedSamples = swapSamples.filter((s) => s.kind === 'saved');
  const swapJump = Math.abs(savedSamples[0]!.textTop - liveSamples.at(-1)!.textTop);
  const savedDrift = Math.max(...savedSamples.map((s) => s.textTop)) - Math.min(...savedSamples.map((s) => s.textTop));
  expect(swapJump).toBeLessThanOrEqual(0.5);
  expect(savedDrift).toBeLessThanOrEqual(0.5);
});

test('chat-switch entrance staggers visible rows once and never replays on same-chat click, reload, or reduced motion', async ({ page }) => {
  await signIn(page);

  // Create two distinct chats with messages via sidebar New chat.
  const makeChat = async (label: string) => {
    await page.getByTestId('sidebar-new-chat').click();
    await page.waitForURL((u) => u.pathname === '/');
    const input = page.getByTestId('composer-input');
    await input.fill(`${label} prompt 1`);
    await input.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });
    await input.fill(`${label} prompt 2`);
    await input.press('Enter');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });
  };

  await makeChat('SwitchAlpha');
  await makeChat('SwitchBravo');

  const sidebar = page.getByRole('complementary', { name: 'Conversation history' });
  const alphaRow = sidebar.getByRole('button', { name: /^SwitchAlpha/ }).first();
  const bravoRow = sidebar.getByRole('button', { name: /^SwitchBravo/ }).first();

  await page.evaluate(() => {
    const w = window as unknown as { __animated: Set<string>; __go: boolean };
    w.__animated = new Set();
    w.__go = true;
    const tick = () => {
      if (!w.__go) return;
      for (const el of document.querySelectorAll<HTMLElement>('[data-chat-column] > [data-message-key]')) {
        const s = getComputedStyle(el);
        const y = new DOMMatrixReadOnly(s.transform === 'none' ? undefined : s.transform).m42;
        if (Number(s.opacity) < 0.99 || Math.abs(y) > 0.5) {
          w.__animated.add(el.dataset.messageKey ?? '');
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await alphaRow.click();
  await page.waitForTimeout(600);
  const firstSwitchAnimated = await page.evaluate(() => {
    const w = window as unknown as { __animated: Set<string> };
    const count = w.__animated.size;
    w.__animated.clear();
    return count;
  });
  expect(firstSwitchAnimated).toBeGreaterThan(0);
  expect(firstSwitchAnimated).toBeLessThanOrEqual(8);

  // Clicking the same active chat must NOT replay the entrance stagger.
  await alphaRow.click();
  await page.waitForTimeout(400);
  const sameChatAnimated = await page.evaluate(() => {
    const w = window as unknown as { __animated: Set<string>; __go: boolean };
    w.__go = false;
    return w.__animated.size;
  });
  expect(sameChatAnimated).toBe(0);

  // Page reload must not set inline opacity or animate rows.
  await page.reload();
  await page.getByTestId('user-message-bubble').first().waitFor();
  expect(
    await page
      .getByTestId('user-message-bubble')
      .first()
      .evaluate((el) => (el as HTMLElement).style.opacity),
  ).toBe('');

  // Reduced motion must skip the chat-switch entrance animation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const w = window as unknown as { __animated: Set<string>; __go: boolean };
    w.__animated = new Set();
    w.__go = true;
    const tick = () => {
      if (!w.__go) return;
      for (const el of document.querySelectorAll<HTMLElement>('[data-chat-column] > [data-message-key]')) {
        const s = getComputedStyle(el);
        const y = new DOMMatrixReadOnly(s.transform === 'none' ? undefined : s.transform).m42;
        if (Number(s.opacity) < 0.99 || Math.abs(y) > 0.5) {
          w.__animated.add(el.dataset.messageKey ?? '');
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await bravoRow.click();
  await page.waitForTimeout(400);
  const reducedSwitchAnimated = await page.evaluate(() => {
    const w = window as unknown as { __animated: Set<string>; __go: boolean };
    w.__go = false;
    return w.__animated.size;
  });
  expect(reducedSwitchAnimated).toBe(0);
});
