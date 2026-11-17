import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';
import {localExec} from './local.js';
import {NOTEBOOK_DRIVER} from './notebook-driver.js';

const DRIVER_TEST_TIMEOUT_MS = 15_000;

it('runs the actual Python driver recovery, cleanup and bounded-output regressions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'praxis-notebook-driver-'));
  try {
    const driver = join(root, 'driver.py');
    await writeFile(driver, NOTEBOOK_DRIVER);
    const fixture = fileURLToPath(new URL('./notebook-driver.fixture.py', import.meta.url));
    const result = await localExec({argv: ['python3', fixture, driver], cwd: root, timeoutMs: DRIVER_TEST_TIMEOUT_MS});
    expect(result.stderr).toContain('Ran 13 tests');
    expect(result.stderr).toContain('OK');
    expect(result.exitCode, result.stderr).toBe(0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}, DRIVER_TEST_TIMEOUT_MS);
