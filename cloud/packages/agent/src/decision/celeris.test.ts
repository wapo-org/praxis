import {describe, expect, it, vi} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {celerisDecisionPort} from './celeris.js';

describe('Celeris decision client', () => {
  it('sends the documented model, path, and authorization', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({model: 'celeris-1.1-decision', answers: [{type: 'predicate', name: 'x', probability: 0.7}], usage: {input_tokens: 12}})));
    const result = await celerisDecisionPort({key: SealedSecret.of('secret'), fetch: fetcher}).decide({query: 'query', candidates: [{key: 'x', kind: 'tool', title: 'Tool', summary: 'Summary', score: 1}]});
    expect(fetcher).toHaveBeenCalledWith('https://inference.celeris.ai/celeris-1-decision/v1/decisions', expect.objectContaining({headers: expect.objectContaining({Authorization: 'Bearer secret'}), body: expect.stringContaining('celeris-1.1-decision')}));
    expect(result.kind).toBe('success');
  });
});
