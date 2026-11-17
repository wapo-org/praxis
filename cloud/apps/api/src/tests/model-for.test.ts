import {describe, expect, it} from 'vitest';
import {DEFAULT_MODEL_ID} from '@praxis/protocol';
import {parseCatalogModel, resolveEffort} from '../openrouter/index.js';
import {catalogEntry, connectKey, setup} from './harness.js';

describe('modelFor: one catalogue read decides model, capabilities and effort', () => {
  it('resolves effort from the catalogue entry: none without reasoning, other names clamped to an offered level', () => {
    const thinking = parseCatalogModel(catalogEntry({id: 'v/think', reasoning: true}))!;
    const plain = parseCatalogModel(catalogEntry({id: 'v/plain'}))!;
    const cases = [
      ['high', 'high'], ['MEDIUM', 'medium'], ['xhigh', 'high'], ['max', 'high'], ['minimal', 'low'],
      ['none', undefined], ['bogus', undefined], [undefined, undefined],
    ] as const;
    for (const [wanted, resolved] of cases) expect(resolveEffort(thinking, wanted)).toBe(resolved);
    expect(resolveEffort(plain, 'high')).toBeUndefined();
  });

  it('unseals the key with the user id and resolves model, capabilities and effort together', async () => {
    const f = setup();
    f.fake.state.models = [
      {id: 'vendor/alpha', tools: true, reasoning: true},
      {id: 'vendor/blind', tools: false},
      {id: DEFAULT_MODEL_ID, name: 'Default', tools: true},
    ];
    await connectKey(f.req);
    const models = f.service.models!;
    const able = await models.modelFor('local-user', 'vendor/alpha', 'max');
    expect([able.model.id, able.effort, able.provider.capabilities.reasoningEffort, able.note]).toEqual(['vendor/alpha', 'high', true, undefined]);
    const blind = await models.modelFor('local-user', 'vendor/blind', 'high');
    expect([blind.effort, blind.provider.capabilities.tools]).toEqual([undefined, false]);
    const gone = await models.modelFor('local-user', 'vendor/removed', 'high');
    expect([gone.model.id, gone.note]).toEqual([DEFAULT_MODEL_ID, expect.stringContaining('vendor/removed')]);
    await expect(models.modelFor('someone-else', 'vendor/alpha', undefined)).rejects.toMatchObject({code: 'model_key_missing'});
  });
});
