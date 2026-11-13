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
      __checks: Array<{ emptyVisible: boolean; bubbleCount: number; hasStop: boolean; hasWorking: boolean }>;
      __stop: boolean;
    };
    w.__checks = [];
    w.__stop = false;
    const tick = () => {
      if (w.__stop) return;
      const empty = document.querySelector('[data-testid="chat-empty-state"]');
      const flight = document.querySelector('[data-testid="send-flight-bubble"]');
      const bubbles = document.querySelectorAll('[data-testid="user-message-bubble"] [data-user-bubble]');
      const stop = document.querySelector('[data-testid="composer-stop-button"]');
      const live = document.querySelector('[data-testid="live-run-streaming-turn"]');
      if (flight || bubbles.length > 0) {
        w.__checks.push({
          emptyVisible: !!empty && getComputedStyle(empty).opacity !== '0',
          bubbleCount: bubbles.length,
          hasStop: !!stop,
          hasWorking: !!live && /Working/.test(live.textContent ?? ''),
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
  await page.waitForFunction(() => !document.querySelector('[aria-label="Stop generating"]'), null, { timeout: 20000 });
  const checks = await page.evaluate(() => {
    const w = window as unknown as {
      __checks: Array<{ emptyVisible: boolean; bubbleCount: number; hasStop: boolean; hasWorking: boolean }>;
      __stop: boolean;
    };
    w.__stop = true;
    return w.__checks;
  });

  expect(checks.length).toBeGreaterThan(2);
  expect(checks.filter((c) => c.emptyVisible)).toHaveLength(0);
  expect(checks.some((c) => c.hasStop && c.hasWorking)).toBe(true);
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

  // Before POST /v1/runs has even responded, client feedback must already be visible.
  await expect(page.getByTestId('live-run-streaming-turn')).toContainText('Working', { timeout: 500 });
  await expect(page.getByTestId('composer-stop-button')).toBeVisible({ timeout: 500 });
  await expect(page.getByTestId('run-backdrop')).toBeAttached({ timeout: 500 });

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
  await expect(page.getByTestId('live-run-streaming-turn')).toContainText('Working', { timeout: 500 });
  await expect(page.getByTestId('composer-stop-button')).toBeVisible({ timeout: 500 });
  await page.waitForTimeout(900);
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
