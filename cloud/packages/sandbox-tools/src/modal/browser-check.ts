import {posix} from 'node:path';
import {readFileSync} from 'node:fs';
import {ModalClient} from 'modal';
import {z} from 'zod';
import {MemoryExportSink} from '../fake.js';
import {browser, BROWSER_SESSION_PATH} from '../tools/browser.js';
import {BROWSER_MEMORY_MIB, sandboxBrowserImage} from './browser-image.js';
import {browserSandboxOptions} from './browser-network.js';
import {modalSandboxPort} from './port.js';

const APP_NAME = 'praxis-pra20-browser';
const ROOT = '/workspace/chats/browser-check';
const FIXTURE_PATH = `${ROOT}/login.html`;
const CPU_CORES = 1;
const SANDBOX_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 30_000;
const MEASURE_TIMEOUT_MS = 30_000;
// Modal mounts image directories separately, so root-only du excludes the installed image.
const IMAGE_SIZE_COMMAND = 'du -sc --apparent-size --block-size=1 /usr /opt /etc /var /root 2>/dev/null | tail -1';
const IMAGE_FOOTPRINT_MIN_BYTES = 100_000_000;
const ByteCountSchema = z.coerce.number().int().min(IMAGE_FOOTPRINT_MIN_BYTES);
const SIGN_IN_TARGET = 'button:Sign in';
const EMAIL_TARGET = 'textbox:Email';
const EMAIL = 'browser-check@example.test';

/** Exactly one build and one boot per opt-in invocation; the sandbox deadline backs up awaited termination. */
export async function checkBrowserImage() {
  const modal = new ModalClient();
  const app = await modal.apps.fromName(APP_NAME, {createIfMissing: true});
  const buildStarted = Date.now();
  const image = await sandboxBrowserImage(modal).build(app);
  const buildMs = Date.now() - buildStarted;
  const bootStarted = Date.now();
  const sandbox = await modal.sandboxes.create(app, image, {
    ...browserSandboxOptions(), cpu: CPU_CORES, memoryMiB: BROWSER_MEMORY_MIB,
    timeoutMs: SANDBOX_TIMEOUT_MS, tags: {wp: 'PRA-20'},
  });
  try {
    await sandbox.waitUntilReady(READY_TIMEOUT_MS);
    const coldStartMs = Date.now() - bootStarted;
    const port = modalSandboxPort(sandbox);
    const exports = new MemoryExportSink();
    const context = {port, root: ROOT, exports, browserNetworkRestricted: true};
    const fixture = readFileSync(new URL('../../../browser-cli/fixtures/login.html', import.meta.url));
    await port.writeFile(FIXTURE_PATH, fixture);
    const measured = await port.exec({argv: ['sh', '-c', IMAGE_SIZE_COMMAND], cwd: ROOT, timeoutMs: MEASURE_TIMEOUT_MS});
    if (measured.timedOut || !measured.stdout.trim()) throw new Error('Image filesystem measurement failed.');
    const filesystemBytes = ByteCountSchema.parse(measured.stdout.trim().split(/\s+/)[0]);
    await browser(context, {action: 'open'});
    // Only the verification harness can navigate a local fixture; model-facing goto accepts HTTPS URLs only.
    const loaded = await port.exec({argv: ['praxis-browser', 'goto', `file://${FIXTURE_PATH}`, '--session', posix.join(ROOT, BROWSER_SESSION_PATH)], cwd: ROOT, timeoutMs: READY_TIMEOUT_MS});
    if (loaded.exitCode !== 0) throw new Error('Fixture navigation failed.');
    const snapshot = await browser(context, {action: 'snapshot'});
    if (!JSON.stringify(snapshot).includes('Sign in')) throw new Error('Fixture snapshot missing sign-in button.');
    await browser(context, {action: 'type', target: EMAIL_TARGET, text: EMAIL});
    await browser(context, {action: 'click', target: SIGN_IN_TARGET});
    await browser(context, {action: 'wait-for', target: `heading:Welcome, ${EMAIL}`});
    const screenshot = await browser(context, {action: 'screenshot'});
    await browser(context, {action: 'close'});
    const screenshotBytes = exports.items[0]?.bytes;
    if (!screenshotBytes) throw new Error('Screenshot proof was not exported.');
    return {screenshotBytes, imageId: image.imageId, buildMs, coldStartMs, filesystemBytes, screenshot};
  } finally {
    await sandbox.terminate({wait: true});
    await sandbox.poll().then(status => {
      if (status === null) throw new Error('Browser check sandbox is still running after termination.');
    });
  }
}
