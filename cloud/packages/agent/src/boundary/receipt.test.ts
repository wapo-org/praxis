import {it, expect} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {ApprovalReceipt, approvalKey, argsHash, issueApproval, type ApprovalReplayStore} from './receipt.js';
const nowMs = 1000;
async function fixture() {
  const key = await approvalKey(SealedSecret.of('a'.repeat(32)));
  const binding = {runId: 'run', toolCallId: 'call', tool: 'send', argsHash: await argsHash({a: 1})};
  const used = new Set<string>();
  const replay: ApprovalReplayStore = {async consume(nonce) {
    if (used.has(nonce)) return false;
    used.add(nonce);
    return true;
  }};
  const wire = await issueApproval(key, binding, nowMs + 100, 'nonce');
  return {key, binding, replay, wire};
}
it('verifies once and rejects a replay', async () => {
  const f = await fixture();
  expect(await ApprovalReceipt.verify(f.wire, f.binding, nowMs, f.key, f.replay)).toBeInstanceOf(ApprovalReceipt);
  expect(await ApprovalReceipt.verify(f.wire, f.binding, nowMs, f.key, f.replay)).toBeNull();
});
it.each(['runId', 'toolCallId', 'tool', 'argsHash'] as const)('rejects foreign/mutated %s', async field => {
  const f = await fixture();
  expect(await ApprovalReceipt.verify(f.wire, {...f.binding, [field]: 'different'}, nowMs, f.key, f.replay)).toBeNull();
});
it('rejects expired receipts including the exact expiry', async () => {
  const f = await fixture();
  expect(await ApprovalReceipt.verify(f.wire, f.binding, nowMs + 100, f.key, f.replay)).toBeNull();
});
it('rejects signature and payload tampering', async () => {
  const f = await fixture();
  expect(await ApprovalReceipt.verify({...f.wire, signature: '0'.repeat(64)}, f.binding, nowMs, f.key, f.replay)).toBeNull();
  expect(await ApprovalReceipt.verify({...f.wire, payload: {...f.wire.payload, expiresAtMs: 9999}}, f.binding, nowMs, f.key, f.replay)).toBeNull();
});
it('rejects a foreign signing key and malformed wire value', async () => {
  const f = await fixture();
  const otherKey = await approvalKey(SealedSecret.of('b'.repeat(32)));
  expect(await ApprovalReceipt.verify(f.wire, f.binding, nowMs, otherKey, f.replay)).toBeNull();
  expect(await ApprovalReceipt.verify({}, f.binding, nowMs, f.key, f.replay)).toBeNull();
});
it('consumes atomically under concurrent verification', async () => {
  const f = await fixture();
  const results = await Promise.all([1, 2].map(() => ApprovalReceipt.verify(f.wire, f.binding, nowMs, f.key, f.replay)));
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('canonicalizes object key order but preserves array order', async () => {
  expect(await argsHash({a: 1, b: 2})).toBe(await argsHash({b: 2, a: 1}));
  expect(await argsHash([1, 2])).not.toBe(await argsHash([2, 1]));
});
it('refuses short signing keys', async () => {
  await expect(approvalKey(SealedSecret.of('short'))).rejects.toThrow('too short');
});
it('rejects a valid hash of changed arguments', async () => {
  const f = await fixture();
  const changed = {...f.binding, argsHash: await argsHash({a: 2})};
  expect(await ApprovalReceipt.verify(f.wire, changed, nowMs, f.key, f.replay)).toBeNull();
});
