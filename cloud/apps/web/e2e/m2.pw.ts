import { openSignedInPage, signedInTest as test } from './sign-in';
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
test.use({ serviceWorkers: 'block', video: 'on' });
test('real Hello turn stays ordered, copies the whole turn, and output scrolls then chains wheel to the page', async ({
  page,
  browserName,
}) => {
  const captures = process.env.HOME + '/.praxis-agent-state/cloud/design/M/M2/test-' + browserName;
  mkdirSync(captures, { recursive: true });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copied: string }).__copied = text;
        },
      },
    });
  });
  await openSignedInPage(page);
  await page.getByTestId('chat-top-bar').waitFor();
  await page.route('**/v1/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.continue({
      postData: JSON.stringify({
        ...route.request().postDataJSON(),
        providerId: 'scripted',
        modelId: 'scripted',
        script: 'helloReplay',
      }),
    });
  });
  await page
    .getByTestId('composer-input')
    .fill('say something then execute a tool then say something and then execute a tool then say something');
  await page.getByTestId('composer-input').press('Enter');
  const first = page.getByText(
    "Got it — I'll demo that rhythm with a couple of quick lookups, starting now.",
    { exact: true },
  );
  await expect(first).toBeVisible();
  await expect(page.getByTestId('agent-activity-toggle').last()).toContainText('Searching the web');
  const y = await first.evaluate((el) => el.getBoundingClientRect().top);
  await page.screenshot({ path: captures + '/streaming.png' });
  await expect(
    page.getByText('First lookup done — now for the second step in that sequence.', { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  expect(Math.abs((await first.evaluate((el) => el.getBoundingClientRect().top)) - y)).toBeLessThan(2);
  await expect(page.getByTestId('turn-copy-button')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('live-run-streaming-turn')).toHaveCount(0, { timeout: 10000 });
  await page.getByTestId('assistant-turn').waitFor({ timeout: 30000 });
  await expect(page.getByTestId('turn-copy-button')).toHaveCount(1);
  await expect(page.getByTestId('turn-retry-button')).toHaveCount(1);
  const turns = page.getByTestId('agent-activity-toggle');
  for (const label of await turns.allTextContents()) expect(label).not.toMatch(/mcp__|_[0-9a-f]{8,}|[0-9]{9,}/);
  await page.getByTestId('turn-copy-button').click();
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain('Got it —');
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain(
    'First lookup done',
  );
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toContain(
    'Wrapping up here',
  );
  const ordered = await page
    .locator('[data-testid="agent-activity-toggle"], [data-timeline-text]')
    .allTextContents();
  expect(
    ordered.map((t) =>
      t.startsWith('Worked')
        ? 'work'
        : t.startsWith('Got it')
          ? 'first'
          : t.startsWith('First lookup')
            ? 'second'
            : 'last',
    ),
  ).toEqual(['work', 'first', 'work', 'second', 'work', 'last']);
  await page.screenshot({ path: captures + '/finished.png' });
  // Tool 1 follows text 1, and its disclosure stays between text 1 and text 2.
  await turns.nth(1).click();
  await expect(turns.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await page.locator('[data-testid="agent-activity-fold"][data-open="true"][data-settled="true"]').waitFor();
  await page.locator('[data-testid^="tool-step-header-"]').first().click();
  await page
    .locator('[data-testid^="tool-step-"] [data-slot="trace-collapsible-content"][data-open="true"][data-settled="true"]')
    .first()
    .waitFor();
  const output = page.locator('section[data-caption="output"]');
  const showAll = output.getByRole('button', { name: 'Show all', exact: true });
  await expect(showAll).toBeVisible();
  const inner = output.locator('[data-slot="code-block-content"]');
  await inner.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  expect(await inner.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  expect(
    await inner.evaluate(
      (el) =>
        Number.parseFloat(getComputedStyle(el).maxHeight) /
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  ).toBeCloseTo(17, 1);
  await expect(inner).toHaveAttribute('data-fade', 'bottom');
  const viewport = page.getByTestId('chat-scroll-viewport');
  const box = (await inner.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => inner.evaluate((el) => el.scrollTop)).toBeGreaterThan(20);
  // Scroll output to bottom, then wheel chains cleanly to the page viewport.
  await inner.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(inner).toHaveAttribute('data-fade', 'top');
  const before = await viewport.evaluate((el) => el.scrollTop);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 20);
  await page.screenshot({ path: captures + '/wheel.png' });
  await showAll.click();
  await expect(output.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
  expect(await inner.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThan(2);
});
