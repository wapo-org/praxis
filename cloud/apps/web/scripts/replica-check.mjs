import { BASE, API } from './check-env.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Continue as local dev user' }).waitFor();
  const result = await page.evaluate(async () => {
    const replica = await import('/src/lib/idb.ts');
    const snapshot = { chats: [{ id: 'private-A' }], messagesByChat: { private: [] } };
    await replica.setReplicaIdentity('https://replica-check.example', 'A');
    await replica.saveReplica(snapshot);
    const a = await replica.loadReplica();
    await replica.setReplicaIdentity('https://replica-check.example', 'B');
    const b = await replica.loadReplica();
    await replica.setReplicaIdentity('https://replica-check.example', 'A');
    const aAfterSwitch = await replica.loadReplica();
    await replica.saveReplica(snapshot);
    await replica.clearReplica();
    await replica.setReplicaIdentity('https://replica-check.example', 'A');
    const afterSignOut = await replica.loadReplica();
    await replica.clearReplica();
    return { a: a.chats[0].id, b, aAfterSwitch, afterSignOut, legacy: localStorage.getItem('praxis-cloud-replica-v1') };
  });
  assert.deepEqual(result, { a: 'private-A', b: null, aAfterSwitch: null, afterSignOut: null, legacy: null });
  console.log('PASS: real IndexedDB read/write, A→B isolation, switch wipe, sign-out wipe, no localStorage history');
} finally { await browser.close(); }
