import {expect, it} from 'vitest';
import fc from 'fast-check';
import {SealedSecret} from '@praxis/types';
import {approvalKey} from './receipt.js';
import {executeBoundary, type BoundaryContext} from './gate.js';
import {ToolBoundaryError, toolError} from './errors.js';
import type {ToolClassifier} from './policy.js';

it('any completed failure from an untrusted tool carries source metadata and monotonically taints the run', async () => {
  const key = await approvalKey(SealedSecret.of('x'.repeat(32)));
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), fc.string(), async (untrustedSource, tainted, typed, message) => {
    const context: BoundaryContext = {mode: 'build', runId: 'run', toolCallId: 'call', taint: {tainted},
      nowMs: () => 1, key, replay: {consume: async () => true}};
    const registry: ToolClassifier = {classify: call => ({
      capabilities: call.tool === 'read' ? ['read'] : ['write'], decision: 'allow',
      untrustedSource: call.tool === 'read' && untrustedSource,
    })};
    const result = await executeBoundary({tool: 'read', args: {}}, context, registry, async () => {
      throw typed ? new ToolBoundaryError(toolError('not-found', message)) : new Error(message);
    });
    expect(result).toMatchObject({ok: false, untrustedSource, taint: {tainted: tainted || untrustedSource}});
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    if (typed && !result.ok) expect(result.error.message).toBe(message);
    const next = await executeBoundary({tool: 'write', args: {}}, {...context, taint: result.taint}, registry, async () => null);
    expect(next.ok).toBe(!(tainted || untrustedSource));
  }), {numRuns: 100});
});

it('pre-execution rejections preserve taint regardless of source classification', async () => {
  const key = await approvalKey(SealedSecret.of('x'.repeat(32)));
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.constantFrom('schema', 'policy', 'mode', 'approval'), async (tainted, untrustedSource, rejection) => {
    const context: BoundaryContext = {mode: rejection === 'mode' ? 'plan' : 'build', runId: 'run', toolCallId: 'call',
      taint: {tainted}, nowMs: () => 1, key, replay: {consume: async () => true}};
    const registry: ToolClassifier = {classify: () => ({capabilities: ['write'], untrustedSource,
      decision: rejection === 'policy' ? 'deny' : rejection === 'approval' ? 'approve' : 'allow'})};
    let executed = false;
    const result = await executeBoundary({tool: rejection === 'schema' ? '' : 'write', args: {}}, context, registry, async () => {
      executed = true;
      return null;
    });
    expect(executed).toBe(false);
    expect(result).toMatchObject({ok: false, untrustedSource: false, taint: {tainted}});
  }), {numRuns: 100});
});
