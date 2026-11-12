import { expect, test, type Page } from '@playwright/test';
// WP-L2: the consent sheet (L-ref/14) and one button and field language (L-ref/10, 14).

async function signIn(page: Page, path = '/') {
  await page.request.post('/v1/auth/dev', { data: { type: 'auth.dev', userId: 'l2-' + Date.now() } });
  await page.goto(path);
}

async function openConsent(page: Page) {
  await signIn(page, '/lab/glass');
  await page.getByTestId('glass-lab-consent-demo').click();
  const pop = page.getByTestId('consent-popover');
  await pop.waitFor();
  return pop;
}

const scrollState = (page: Page) => page.getByTestId('consent-scroll').evaluate((el) => {
  const s = getComputedStyle(el);
  return { overflow: el.scrollHeight > el.clientHeight + 1, padding: parseFloat(s.paddingBottom), mask: (s.maskImage || (s as any).webkitMaskImage || 'none') !== 'none' };
});

test('the consent sheet is sized to its content when it fits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openConsent(page);
  await expect.poll(() => scrollState(page)).toEqual({ overflow: false, padding: 0, mask: false });
});

test('when the consent sheet must scroll it ends on padding, and the soft edge shows only while more is below', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 470 });
  await openConsent(page);
  await expect.poll(() => scrollState(page)).toEqual({ overflow: true, padding: 16, mask: true });
  await page.getByTestId('consent-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(() => scrollState(page)).toEqual({ overflow: true, padding: 16, mask: false });
  // The last line rests above the padding, inside the box.
  const gap = await page.getByTestId('consent-scroll').evaluate((el) => {
    const last = el.lastElementChild!.getBoundingClientRect(), box = el.getBoundingClientRect();
    return box.bottom - last.bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(12);
});

test('consent, question card and Settings share one button and one field', async ({ page }) => {
  const look = (el: Element) => {
    // Layout size: the cards arrive with a scale.
    const s = getComputedStyle(el), h = (el as HTMLElement).offsetHeight;
    return { height: h, radius: parseFloat(s.borderTopLeftRadius) >= h / 2 - 0.5, font: `${s.fontWeight} ${s.fontSize}` };
  };
  const pop = await openConsent(page);
  const allow = await pop.getByRole('button', { name: 'Allow' }).evaluate(look);
  const cancel = await pop.getByRole('button', { name: 'Cancel' }).evaluate(look);
  await page.goto('/');
  await page.getByTestId('composer-input').fill('Start an elicitation');
  await page.getByTestId('composer-send-button').click();
  const submit = await page.getByTestId('elicitation-submit-save').evaluate(look);
  const field = await page.getByTestId('elicitation-input-name').evaluate(look);
  await page.goto('/settings/providers/new');
  const settingsField = await page.getByRole('textbox').first().evaluate(look);
  for (const b of [allow, cancel, submit]) expect(b).toEqual({ height: 36, radius: true, font: '500 12px' });
  expect(field).toEqual({ height: 36, radius: true, font: '400 14px' });
  expect(settingsField).toEqual(field);
});
