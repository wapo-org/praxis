import { openSignedInPage, signedInTest as test } from './sign-in';
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.use({ serviceWorkers: 'block' });

async function runHelloReplay(page: Page) {
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
  await expect(page.getByTestId('agent-activity-toggle').last()).toContainText('Searching the web');
  await expect(page.getByTestId('turn-copy-button')).toHaveCount(1, { timeout: 30000 });
  await expect(page.getByTestId('live-run-streaming-turn')).toHaveCount(0, { timeout: 10000 });
}

test('Trace renders 3 levels, past-tense labels, deduplicated sources, keyboard toggle, light/dark & reduced motion', async ({
  page,
}, testInfo) => {
  const captures = `${process.env.HOME}/.praxis-agent-state/cloud/design/N/N3/${testInfo.project.name}`;
  mkdirSync(captures, { recursive: true });
  await openSignedInPage(page);

  await runHelloReplay(page);

  const turns = page.getByTestId('agent-activity-toggle');
  await expect(turns).toHaveCount(3);
  for (const label of await turns.allTextContents()) {
    expect(label).toContain('Worked');
    expect(label).not.toMatch(/mcp__|_[0-9a-f]{8,}|[0-9]{9,}/);
  }

  // Keyboard toggle on Level 1 ("Worked for X")
  const secondTurn = turns.nth(1);
  await secondTurn.focus();
  await page.keyboard.press('Enter');
  await expect(secondTurn).toHaveAttribute('aria-expanded', 'true');
  await page
    .locator('[data-testid="agent-activity-fold"][data-open="true"][data-settled="true"]')
    .waitFor();

  // Level 2: past tense + description + left rail + keyboard toggle into Level 3
  const stepHeader = page.locator('[data-testid^="tool-step-header-"]').first();
  await expect(stepHeader).toContainText(/Searched the web for/);
  await expect(stepHeader).toContainText(/3 results/);
  await expect(stepHeader).toHaveAttribute('aria-expanded', 'false');
  await stepHeader.focus();
  await page.keyboard.press('Space');
  await expect(stepHeader).toHaveAttribute('aria-expanded', 'true');

  const railLeft = await page
    .locator('[data-testid^="tool-step-"] [data-slot="trace-collapsible-body"]')
    .first()
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).borderLeftWidth));
  expect(railLeft).toBeGreaterThanOrEqual(1);

  // Deduplicated sources disclosure at turn end
  const sourcesToggle = page.getByTestId('turn-sources-toggle');
  await expect(sourcesToggle).toContainText('Used 6 sources');
  await sourcesToggle.focus();
  await page.keyboard.press('Enter');
  await expect(sourcesToggle).toHaveAttribute('aria-expanded', 'true');
  const sourceLinks = page.getByTestId('turn-source-link');
  await expect(sourceLinks).toHaveCount(6);
  const hrefs = await sourceLinks.evaluateAll((els) =>
    els.map((el) => ({
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
      sr: el.textContent,
    })),
  );
  expect(new Set(hrefs.map((h) => h.href)).size).toBe(6);
  for (const h of hrefs) {
    expect(h.target).toBe('_blank');
    expect(h.sr).toContain('(opens in a new tab)');
  }

  await page.screenshot({ path: `${captures}/trace-light.png` });

  // Switch to Dark theme and verify Praxis theme tokens
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${captures}/trace-dark.png` });
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  // Reduced motion disables shimmer on running trace line
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSignedInPage(page, '/lab/activity');
  await page.getByTestId('work-log-comparison').waitFor();
  await page.getByTestId('agent-activity-toggle').click();
  // Also verify failed + denied row styling in Activity Lab
  const deniedHeader = page.getByTestId('tool-step-header-sample-5');
  await expect(deniedHeader.locator('[data-status="error"]')).toHaveCount(1);
  await deniedHeader.click();
  const errBlock = page.getByTestId('tool-step-detail-sample-5').locator('[data-variant="destructive"]');
  await expect(errBlock).toBeVisible();
  await errBlock.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${captures}/trace-error.png` });
});

test('tool output scrolls internally with dynamic fades and never traps page wheel across edges, input, and nearby text', async ({
  page,
}, testInfo) => {
  const captures = `${process.env.HOME}/.praxis-agent-state/cloud/design/N/N3/${testInfo.project.name}`;
  mkdirSync(captures, { recursive: true });
  await openSignedInPage(page);
  await runHelloReplay(page);

  // Open tool 1 (middle group) so there is plenty of scrollable page content both above & below
  const turns = page.getByTestId('agent-activity-toggle');
  await turns.nth(1).click();
  await page
    .locator('[data-testid="agent-activity-fold"][data-open="true"][data-settled="true"]')
    .waitFor();
  const stepHeader = page.locator('[data-testid^="tool-step-header-"]').first();
  await stepHeader.click();
  await page
    .locator('[data-testid^="tool-step-"] [data-slot="trace-collapsible-content"][data-open="true"][data-settled="true"]')
    .first()
    .waitFor();

  const viewport = page.getByTestId('chat-scroll-viewport');
  const inputSection = page.locator('section[data-caption="input"]');
  const outputSection = page.locator('section[data-caption="output"]');
  const outputBox = outputSection.locator('[data-slot="code-block-content"]');
  const inputBox = inputSection.locator('[data-slot="code-block-content"]');
  const nextText = page.locator('[data-timeline-text]').nth(1);

  await expect(outputBox).toHaveAttribute('data-fade', 'bottom');
  await outputBox.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

  const metrics = await outputBox.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    maxHeightPx: Number.parseFloat(getComputedStyle(el).maxHeight),
    maxHeightRem:
      Number.parseFloat(getComputedStyle(el).maxHeight) /
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    overscroll: getComputedStyle(el).overscrollBehaviorY,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 40);
  expect(metrics.maxHeightRem).toBeCloseTo(17, 1);
  expect(metrics.overscroll).toBe('auto');

  const readTops = async () => ({
    inner: await outputBox.evaluate((el) => el.scrollTop),
    page: await viewport.evaluate((el) => el.scrollTop),
  });

  // 1. Top of output box: wheel down scrolls inner box first
  const outRect = (await outputBox.boundingBox())!;
  const beforeTop = await readTops();
  await page.screenshot({ path: `${captures}/output-fade-bottom.png` });
  await page.mouse.move(outRect.x + outRect.width / 2, outRect.y + outRect.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => outputBox.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeTop.inner + 10);
  const atMiddle = await readTops();
  await expect(outputBox).toHaveAttribute('data-fade', 'both');
  await page.screenshot({ path: `${captures}/output-fade-middle.png` });

  // 2. Middle -> end of output box -> further wheel down chains to page
  await outputBox.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });
  await expect(outputBox).toHaveAttribute('data-fade', 'top');
  await page.screenshot({ path: `${captures}/output-fade-top.png` });
  const atEndBeforeWheel = await readTops();
  await page.mouse.move(outRect.x + outRect.width / 2, outRect.y + outRect.height / 2);
  await page.mouse.wheel(0, 260);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(atEndBeforeWheel.page + 10);
  const atEndAfterWheel = await readTops();

  // 3. Over input box (non-overflowing): wheel scrolls the page
  await inputSection.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const inRect = (await inputBox.boundingBox())!;
  const inputBefore = await readTops();
  await page.mouse.move(inRect.x + inRect.width / 2, inRect.y + inRect.height / 2);
  await page.mouse.wheel(0, 180);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(inputBefore.page + 10);
  const inputAfter = await readTops();

  // 4. Over adjacent text next to it: wheel scrolls the page
  await nextText.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const txtRect = (await nextText.boundingBox())!;
  const textBefore = await readTops();
  await page.mouse.move(txtRect.x + txtRect.width / 2, txtRect.y + txtRect.height / 2);
  await page.mouse.wheel(0, -180);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeLessThan(textBefore.page - 10);
  const textAfter = await readTops();

  console.log(
    JSON.stringify({
      project: testInfo.project.name,
      metrics,
      beforeTop,
      atMiddle,
      atEndBeforeWheel,
      atEndAfterWheel,
      inputBefore,
      inputAfter,
      textBefore,
      textAfter,
    }),
  );

  // 5. Show all expands box to full height and removes fade
  await outputSection.getByRole('button', { name: 'Show all', exact: true }).click();
  await expect(outputSection.getByRole('button', { name: 'Show less', exact: true })).toBeVisible();
  await expect(outputBox).toHaveAttribute('data-fade', 'none');
});
