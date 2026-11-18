import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const SETTINGS_PATH = '/tmp/ui-preview.json';
const EVIDENCE_ROOT = '/tmp/ui-evidence';
const VIEWPORT = { width: 1280, height: 720 };
const ACTION_TIMEOUT_MS = 15_000;
const WORKFLOW_TIMEOUT_MS = 120_000;
const FRAME_HOLD_MS = 500;
const FLOW_NUMBER = /^[1-4]$/u;

const [flowNumber, script] = process.argv.slice(2);
if (!FLOW_NUMBER.test(flowNumber ?? '') || !script?.startsWith('/tmp/')) {
  throw new Error('Usage: record.mjs <flow number 1–4> /tmp/workflow.mjs');
}

const { baseURL, cookie } = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
const directory = `${EVIDENCE_ROOT}/flow-${flowNumber}`;
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: false });
try {
  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT,
    recordVideo: { dir: directory, size: VIEWPORT },
  });
  if (cookie) await context.addCookies([cookie]);
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  const page = await context.newPage();
  const video = page.video();
  page.on('pageerror', error => console.error(`Page error: ${error.message}`));
  let passed = false;
  let timeout;
  try {
    const run = async () => {
      const response = await page.goto(baseURL);
      if (!response?.ok() || new URL(page.url()).origin !== baseURL) {
        throw new Error(`Could not load the Vercel preview (HTTP ${response?.status() ?? 'unknown'})`);
      }
      const workflow = await import(pathToFileURL(script).href);
      await workflow.default({ page, baseURL });
    };
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Workflow timed out')), WORKFLOW_TIMEOUT_MS);
      }),
    ]);
    passed = true;
  } finally {
    clearTimeout(timeout);
    await new Promise(resolve => setTimeout(resolve, FRAME_HOLD_MS));
    await context.close();
    await rename(await video.path(), `${directory}/workflow.webm`);
    await writeFile(`${directory}/result.json`, JSON.stringify({ passed }));
  }
} finally {
  await browser.close();
}
