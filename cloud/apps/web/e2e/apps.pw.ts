import { openSignedInPage, signedInTest as test } from './sign-in';
import { expect } from '@playwright/test';

test('cold draft tray always shows the same Apps row across five openings', async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await openSignedInPage(page);
    await page.getByTestId('composer-plus-button').click();
    await expect(page.getByTestId('plus-tray').getByRole('button', { name: /App Directory/ })).toBeVisible();
    await page.keyboard.press('Escape');
  }
});

test('plus tray fits short windows and its Apps view opens the App Directory', async ({ page }) => {
  await openSignedInPage(page);
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto('/');
  await page.getByTestId('composer-plus-button').click();
  const tray = page.getByTestId('plus-tray');
  await tray.waitFor();
  const box = await tray.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(4);
  await page.getByTestId('tray-apps-trigger').click();
  await expect(page.getByTestId('tray-apps-empty')).toBeVisible();
  const manage = page.getByTestId('tray-apps-manage');
  const search = page.getByLabel('Search apps');
  const [searchBox, manageBox] = await Promise.all([search.boundingBox(), manage.boundingBox()]);
  expect(Math.abs(searchBox!.y + searchBox!.height / 2 - (manageBox!.y + manageBox!.height / 2))).toBeLessThan(6);
  await manage.click();
  await expect(page).toHaveURL(/\/settings\/apps$/);
  await expect(page.getByRole('list', { name: 'Apps' }).getByRole('listitem')).toHaveCount(7);
});
