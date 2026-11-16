import {it, expect} from 'vitest';
import fc from 'fast-check';
import {SealedSecret} from '@praxis/types';
import {classifyInvocation, propagateTaint, resultTaint, type ToolClassifier} from './policy.js';
import {executeBoundary, type BoundaryContext} from './gate.js';
import {approvalKey, argsHash, issueApproval} from './receipt.js';
const registry: ToolClassifier = {classify(call) {
  if (call.tool === 'read') return {capabilities: ['read'], decision: 'allow', untrustedSource: true};
  if (call.tool === 'send') return {capabilities: ['external-egress'], decision: 'allow', untrustedSource: false};
  if (call.tool === 'forbidden') return {capabilities: ['exec'], decision: 'deny', untrustedSource: false};
}};
const batch = (tools: string[]) => ({tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: {tools: tools.map(tool_slug => ({tool_slug, arguments: {}}))}});
it('unwraps inner capabilities, taint and the strictest decision', () => {
  expect(classifyInvocation(batch(['read', 'send', 'forbidden']), registry)).toEqual({
    capabilities: ['read', 'external-egress', 'exec'], decision: 'deny', untrustedSource: true,
  });
});
it('defaults unknown actions to side effects', () => {
  expect(classifyInvocation(batch(['unknown']), registry)).toMatchObject({decision: 'approve', untrustedSource: true});
});
it.each([{}, {tool: 'COMPOSIO_MULTI_EXECUTE_TOOL', args: {}}, batch([])])('denies malformed meta-tools: %j', call => {
  expect(classifyInvocation(call, registry).decision).toBe('deny');
});
it('bounds nested meta-tool recursion', () => {
  const call = batch(['read']);
  expect(classifyInvocation(call, registry, [{recognizes: () => true, unwrap: () => [call]}]).decision).toBe('deny');
});
it('does not classify only the benign outer tool name', () => {
  expect(classifyInvocation(batch(['send']), registry).capabilities).toContain('external-egress');
});
it('Taint Propagation & Atomic Spend Caps: taint cannot be cleared mid-run', () => {
  fc.assert(fc.property(fc.array(fc.boolean()), flags => {
    let state = {tainted: false};
    for (const untrustedSource of flags) {
      const previous = state;
      state = resultTaint(state, {value: null, untrustedSource});
      state = propagateTaint(state, {tainted: false});
      expect(state.tainted).toBe(previous.tainted || untrustedSource);
    }
  }), {numRuns: 1000});
});
async function context(tainted = true): Promise<BoundaryContext> {
  const used = new Set<string>();
  return {mode: 'auto', runId: 'run', toolCallId: 'call', taint: {tainted}, nowMs: () => 1000,
    key: await approvalKey(SealedSecret.of('x'.repeat(32))),
    replay: {async consume(nonce) {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    }},
  };
}
it.each(['write', 'external-egress', 'exec'] as const)('blocks tainted %s without a receipt', async capability => {
  let executed = false;
  const result = await executeBoundary({tool: 'effect', args: {}}, await context(), {
    classify: () => ({capabilities: [capability], decision: 'allow', untrustedSource: false}),
  }, async () => {executed = true; return null;});
  expect(result).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
  expect(executed).toBe(false);
});
it('allows a verified meta-tool batch once while retaining taint', async () => {
  const ctx = await context();
  const call = batch(['read', 'send']);
  const wire = await issueApproval(ctx.key, {runId: ctx.runId, toolCallId: ctx.toolCallId, tool: call.tool, argsHash: await argsHash(call.args)}, 2000, 'n');
  expect(await executeBoundary(call, ctx, registry, async () => null, wire)).toMatchObject({ok: true, taint: {tainted: true}});
  expect(await executeBoundary(call, ctx, registry, async () => null, wire)).toMatchObject({ok: false});
});
it('gates untainted effects and permits untrusted reads that taint', async () => {
  const ctx = await context(false);
  expect(await executeBoundary({tool: 'send', args: {}}, ctx, registry, async () => null)).toMatchObject({ok: false, error: {code: 'approval-required'}});
  expect(await executeBoundary({tool: 'read', args: {}}, ctx, registry, async () => 'email')).toMatchObject({ok: true, result: {untrustedSource: true}, taint: {tainted: true}});
});
it('never lets a receipt override a policy denial', async () => {
  expect(await executeBoundary({tool: 'forbidden', args: {}}, await context(), registry, async () => null)).toMatchObject({ok: false, error: {code: 'policy-denied'}});
});

it.each(['ask', 'plan'] as const)('refuses effects in %s mode', async mode => {
  const ctx = {...await context(), mode};
  expect(await executeBoundary({tool: 'send', args: {}}, ctx, registry, async () => null)).toMatchObject({ok: false, error: {code: 'policy-denied'}});
});
