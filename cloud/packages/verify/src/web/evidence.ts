import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Page} from '@playwright/test';
import {FLOW_ACTION_TIMEOUT_MS} from '../constants.js';

/** The accessibility tree as Playwright's YAML; flows store it and praxis-browser annotates it with refs. */
export function accessibilitySnapshot(page: Page, timeout = FLOW_ACTION_TIMEOUT_MS): Promise<string> {
  return page.locator('body').ariaSnapshot({timeout});
}

export interface ScreenshotEvidence {
  path: string;
  sha256: string;
  bytes: number;
}

/** Full-page PNG plus its hash, so a proof can name exactly which image it relied on. */
export async function screenshotEvidence(page: Page, path: string, timeout = FLOW_ACTION_TIMEOUT_MS): Promise<ScreenshotEvidence> {
  await page.screenshot({path, fullPage: true, timeout});
  const bytes = readFileSync(path);
  return {path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
}
