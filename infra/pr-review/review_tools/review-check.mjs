#!/usr/bin/env node
// Runs the tester's check against the signed-in preview; only this context is recorded, never the sign-in.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire('/opt/review-tools/package.json');
const { chromium } = require('playwright');

const WORK_DIR = '/root/review';
const STATE_PATH = `${WORK_DIR}/preview-state.json`;
const ARTIFACT_DIR = `${WORK_DIR}/artifacts`;
const STEP_DIR = `${ARTIFACT_DIR}/steps`;
const VIDEO_DIR = `${WORK_DIR}/video`;
const VIDEO_PATH = `${ARTIFACT_DIR}/development.webm`;
const CHECK_TIMEOUT_MS = 180_000;
const LIST_MAX = 20;
const TEXT_MAX_CHARS = 300;
const VIEWPORT = { width: 1280, height: 800 };

const scriptPath = process.argv[2];
const webOrigin = readFileSync(`${WORK_DIR}/preview-origin`, 'utf8').trim();
if (!scriptPath || !existsSync(scriptPath)) {
  console.log(JSON.stringify({ ok: false, error: 'usage: review-check /root/review/check.mjs' }));
  process.exit(2);
}

const short = text => String(text).replace(/\s+/g, ' ').slice(0, TEXT_MAX_CHARS);
const push = (list, item) => { if (list.length < LIST_MAX) list.push(item); };
const report = { ok: false, error: null, steps: [], console_errors: [], page_errors: [], failed_requests: [] };

rmSync(STEP_DIR, { recursive: true, force: true });
rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(STEP_DIR, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: STATE_PATH,
  viewport: VIEWPORT,
  recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
});
const page = await context.newPage();
page.on('console', message => { if (message.type() === 'error') push(report.console_errors, short(message.text())); });
page.on('pageerror', error => push(report.page_errors, short(error.message)));
page.on('requestfailed', request => push(report.failed_requests, short(`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`)));
page.on('response', response => {
  if (response.status() >= 400) push(report.failed_requests, short(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`));
});

let index = 0;
const step = async label => {
  index += 1;
  const name = `${String(index).padStart(2, '0')}-${short(label).replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`;
  await page.screenshot({ path: `${STEP_DIR}/${name}` });
  report.steps.push(short(label));
};

try {
  await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('chat-top-bar').waitFor({ timeout: 30_000 });
  const { default: check } = await import(`${pathToFileURL(resolve(scriptPath)).href}?run=${Date.now()}`);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS); });
  await Promise.race([check({ page, step }), timeout]).finally(() => clearTimeout(timer));
  report.ok = true;
} catch (error) {
  report.error = short(error instanceof Error ? error.message : error);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) renameSync(await video.path(), VIDEO_PATH);
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
