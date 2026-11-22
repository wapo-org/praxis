import {it, expect} from 'vitest';
import fc from 'fast-check';
import {SealedSecret} from '@praxis/types';
import type {Mode, ToolCapability} from '@praxis/protocol';
import {boundaryDecision} from './decision.js';
import {executeBoundary} from './gate.js';
import {approvalKey, argsHash, issueApproval} from './receipt.js';
import type {PolicyDecision} from './shell.js';
import type {ToolClassification} from './policy.js';

const modes: Mode[] = ['ask', 'plan', 'build', 'auto'];
const decisions: PolicyDecision[] = ['allow', 'approve', 'deny'];
const capabilities: ToolCapability[] = ['read', 'write', 'exec', 'external-egress'];
const cases = modes.flatMap(mode => decisions.flatMap(decision => capabilities.flatMap(capability =>
  [false, true].flatMap(tainted => [false, true].flatMap(destructive => [false, true].map(untrustedWrite =>
    ({mode, decision, capability, tainted, destructive, untrustedWrite})))))));
it.each(cases)('decision table: %j', ({mode, decision, capability, tainted, destructive, untrustedWrite}) => {
  const policy = {capabilities: [capability], decision, untrustedSource: false, destructive, untrustedWrite};
  let expected: PolicyDecision;
  if (decision === 'deny' || ((mode === 'ask' || mode === 'plan') && capability !== 'read')) {
    expected = 'deny';
  } else if (decision === 'approve') {
    expected = 'approve';
  } else if ((mode === 'build' || mode === 'auto') && (
    capability === 'external-egress' || (tainted && capability !== 'read') ||
    (mode === 'auto' && (destructive || untrustedWrite))
  )) {
    expected = 'approve';
  } else {
    expected = 'allow';
  }
  expect(boundaryDecision(mode, policy, tainted)).toBe(expected);
});
it('tainted side effects never execute without a valid receipt', async () => {
  const key = await approvalKey(SealedSecret.of('x'.repeat(32)));
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...modes), fc.constantFrom(...decisions),
    fc.constantFrom<ToolCapability>('write', 'exec', 'external-egress'),
    fc.constantFrom('missing', 'forged', 'valid'), async (mode, decision, capability, receiptKind) => {
      let dispatched = false;
      const call = {tool: 'effect', args: {target: '/workspace/a'}};
      const binding = {runId: 'r', toolCallId: 'c', tool: call.tool, argsHash: await argsHash(call.args)};
      const wire = await issueApproval(key, binding, 2000, crypto.randomUUID());
      const receipt = receiptKind === 'missing' ? undefined : receiptKind === 'forged' ? {...wire, signature: '0'.repeat(64)} : wire;
      await executeBoundary(call, {
        mode, runId: 'r', toolCallId: 'c', taint: {tainted: true}, key,
        nowMs: () => 1000, replay: {consume: async () => true},
      }, {classify: (): ToolClassification => ({capabilities: [capability], decision, untrustedSource: false})},
      async () => {dispatched = true; return null;}, receipt);
      expect(dispatched).toBe(receiptKind === 'valid' && decision !== 'deny' && (mode === 'build' || mode === 'auto'));
    }), {numRuns: 1000});
});
it.each(['build', 'auto'] as const)('executes untainted confined writes in %s without a receipt', async mode => {
  const key = await approvalKey(SealedSecret.of('x'.repeat(32)));
  for (const capability of ['write', 'exec'] as const) {
    const result = await executeBoundary({tool: 'workspace', args: {}}, {
      mode, runId: 'r', toolCallId: 'c', taint: {tainted: false}, key,
      nowMs: () => 1000, replay: {consume: async () => false},
    }, {classify: () => ({capabilities: [capability], decision: 'allow', untrustedSource: false})}, async () => 'done');
    expect(result).toMatchObject({ok: true});
  }
});
