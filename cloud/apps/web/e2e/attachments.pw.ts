import { expect, test } from '@playwright/test';

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_1X1 = Buffer.from(PNG_1X1_B64, 'base64');

test('attachments: paste, drag-drop, upload errors, groups of 1/3/8 in composer & bubble, vertical images & horizontal files', async ({ page }) => {
  await page.request.post('/v1/auth/dev', {
    data: { type: 'auth.dev', userId: `attachments-${test.info().project.name}-${Date.now()}` },
  });
  await page.goto('/');
  await page.getByTestId('composer-input').waitFor();

  // Tray Photos / Camera / Files / Screenshot tiles exist cleanly
  await page.getByTestId('composer-plus-button').click();
  await expect(page.getByTestId('tray-tile-photos')).toBeVisible();
  await expect(page.getByTestId('tray-tile-camera')).toBeVisible();
  await expect(page.getByTestId('tray-tile-files')).toBeVisible();
  await expect(page.getByTestId('tray-tile-screenshot')).toBeVisible();
  await page.keyboard.press('Escape');

  // Drop 1 image onto composer dock -> shows image preview card in composer
  await page.evaluate((b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped-shot.png', { type: 'image/png' }));
    const dock = document.querySelector('[data-testid="composer-dock"]')!;
    dock.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG_1X1_B64);
  const strip = page.getByTestId('composer-attachments-strip');
  await expect(strip.locator('[data-slot="attachment"]')).toHaveCount(1);
  await expect(strip).toContainText('dropped-shot.png');

  // Paste 2 more files -> group of 3
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# Report\nhello'], 'notes.md', { type: 'text/markdown' }));
    dt.items.add(new File(['{"ok":true}'], 'config.json', { type: 'application/json' }));
    const input = document.querySelector('[data-testid="composer-input"]')!;
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
  });
  await expect(strip.locator('[data-slot="attachment"]')).toHaveCount(3);

  // Add 5 more valid files -> group of 8 (horizontal snap scroll + edge fade)
  await page.getByTestId('composer-file-input').setInputFiles([
    { name: 'shot-1.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: 'spec-1.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: 'spec-2.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
    { name: 'spec-3.txt', mimeType: 'text/plain', buffer: Buffer.from('c') },
    { name: 'spec-4.txt', mimeType: 'text/plain', buffer: Buffer.from('d') },
  ]);
  await expect(strip.locator('[data-slot="attachment"]')).toHaveCount(8);
  await expect
    .poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth))
    .toBe(true);
  await expect
    .poll(() => strip.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--fade-right'))))
    .toBeGreaterThan(0);

  // Over-limit file (> 25 MB uploadBytes limit) -> error state & removes cleanly
  await page.getByTestId('composer-file-input').setInputFiles({
    name: 'too-big.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(25_100_000, 1),
  });
  const errChip = strip.locator('[data-slot="attachment"][data-state="error"]');
  await expect(errChip).toBeVisible();
  await errChip.getByRole('button', { name: 'Remove too-big.bin' }).click();
  await expect(strip.locator('[data-slot="attachment"]')).toHaveCount(8);

  // Wait for uploads to settle (none uploading) and send
  await expect(strip.locator('[data-slot="attachment"][data-state="uploading"]')).toHaveCount(0);
  await page.getByTestId('composer-input').fill('Check these 8 attachments');
  await page.getByTestId('composer-input').press('Enter');

  const bubble = page.getByTestId('user-message-bubble').last();
  await bubble.waitFor();
  // Images are vertical with preview; files are horizontal with type · size
  const verticalImgs = bubble.locator('[data-slot="attachment"][data-orientation="vertical"]');
  const horizontalFiles = bubble.locator('[data-slot="attachment"][data-orientation="horizontal"]');
  await expect(verticalImgs).toHaveCount(2);
  await expect(horizontalFiles).toHaveCount(6);
  await expect(horizontalFiles.first()).toContainText('·');
  await expect(horizontalFiles.first().locator('[data-slot="attachment-trigger"]')).toHaveAttribute(
    'href',
    /\/v1\/uploads\/.*\/download/,
  );

  // Clicking vertical image opens lightbox preview
  await bubble.getByTestId('attachment-thumb').first().click();
  await expect(page.getByRole('dialog', { name: 'Image preview' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Image preview' }).click();
});
