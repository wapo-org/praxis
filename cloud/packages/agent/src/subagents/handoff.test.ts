import {it, expect} from 'vitest';
import {VerifiedHandoff} from './handoff.js';
import {workspacePort, handoff, bytes} from './test-fixtures.js';
const expected = {id: 'child', revision: 0, requiredChecks: ['typecheck']};
it('verifies actual artifact bytes, bound identity and revision, and reruns checks', async () => {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  const record = {...handoff(), artifacts: [{path: 'result.txt', sha256}]};
  const seen: string[] = [];
  const proof = await VerifiedHandoff.verify(record, expected, {...workspacePort, readArtifact: async (root, path) => {
    seen.push(root + '/' + path);
    return bytes;
  }});
  expect(proof).not.toBeNull();
  expect(seen).toEqual(['/workspace/.agents/child/result.txt']);
  expect(VerifiedHandoff.valid(proof!, 'child', 0, ['typecheck'])).toBe(true);
  record.diff_summary = 'mutated';
  const copy = proof!.record;
  copy.diff_summary = 'mutated too';
  expect(proof!.record.diff_summary).toBe('Added a verified artifact');
});
it.each([
  {...handoff(), subagent_id: 'other'}, {...handoff(), revision: 1},
  {...handoff(), checks: []}, {...handoff(), checks: [{id: 'typecheck', status: 'skipped'}]},
  {...handoff(), checks: [{id: 'irrelevant', status: 'passed'}]},
  {...handoff(), artifacts: [{path: '../escape', sha256: '0'.repeat(64)}]},
  {...handoff(), artifacts: [{path: 'result', sha256: '0'.repeat(64)}]},
])('refuses unverified handoff %j', async record => {
  expect(await VerifiedHandoff.verify(record, expected, workspacePort)).toBeNull();
});
it('fails closed on verification errors and missing/duplicate check results', async () => {
  for (const verifyChecks of [async () => [], async () => [{id: 'typecheck', status: 'failed'}],
    async () => [{id: 'typecheck', status: 'passed'}, {id: 'typecheck', status: 'passed'}],
    async () => {throw new Error('unavailable');}]) {
    expect(await VerifiedHandoff.verify(handoff(), expected, {...workspacePort, verifyChecks})).toBeNull();
  }
});
it('cannot use a stale, foreign or insufficient proof', async () => {
  const proof = await VerifiedHandoff.verify(handoff(), expected, workspacePort);
  expect(VerifiedHandoff.valid(proof!, 'other', 0, ['typecheck'])).toBe(false);
  expect(VerifiedHandoff.valid(proof!, 'child', 1, ['typecheck'])).toBe(false);
  expect(VerifiedHandoff.valid(proof!, 'child', 0, ['security'])).toBe(false);
  expect(VerifiedHandoff.valid(undefined, 'child', 0, ['typecheck'])).toBe(false);
});
it('hashes artifacts after verification checks so changed outputs cannot pass', async () => {
  let currentBytes = bytes;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const record = {...handoff(), artifacts: [{path: 'result', sha256}]};
  const proof = await VerifiedHandoff.verify(record, expected, {...workspacePort,
    verifyChecks: async () => {
      currentBytes = new TextEncoder().encode('changed by check');
      return [{id: 'typecheck', status: 'passed'}];
    },
    readArtifact: async () => currentBytes,
  });
  expect(proof).toBeNull();
});
