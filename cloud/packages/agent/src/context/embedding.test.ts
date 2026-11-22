import {describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {embedQuery, embedTexts, fakeEmbedder} from './embedding.js';

describe('context embedding client', () => {
  it('truncates provider vectors and normalizes them', async () => {
    const fetcher = (async () => Response.json({data: [{embedding: [3, 4, 0]}]})) as typeof fetch;
    const [vector] = await embedTexts(SealedSecret.of('secret'), 'model', 2, ['text'], fetcher);
    expect(vector).toEqual([0.6, 0.8]);
  });

  it('retries rejected image input as text and reports the fallback', async () => {
    let requests = 0;
    const fetcher = (async (_url, init) => {
      requests++;
      if (requests === 1) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          input: [{content: [{type: 'text', text: 'question'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,AA=='}}]}],
        });
        return Response.json({error: {message: 'image unsupported'}}, {status: 400});
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({input: ['question']});
      return Response.json({data: [{embedding: [3, 4]}]});
    }) as typeof fetch;
    await expect(embedQuery(SealedSecret.of('secret'), 'model', 2, {text: 'question', images: ['data:image/png;base64,AA==']}, fetcher))
      .resolves.toMatchObject({embedding: [0.6, 0.8], imagesDropped: true});
    expect(requests).toBe(2);
  });

  it('provides deterministic unit vectors for tests', () => {
    const embed = fakeEmbedder(8);
    expect(embed(['same'])).toEqual(embed(['same']));
    expect(Math.hypot(...embed(['same'])[0]!)).toBeCloseTo(1);
  });
});
