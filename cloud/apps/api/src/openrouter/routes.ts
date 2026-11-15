import type {Hono} from 'hono';
import {ModelKeyConnectInputSchema, ModelPreferenceSchema, PageQuerySchema} from '@praxis/protocol';
import {body, page} from '../route-helpers.js';
import {ApiError} from '../service.js';
import type {OpenRouterModels} from './index.js';

/** `/v1/model-key*` and `/v1/models*`. Session auth, rate limits and origin checks come from the `/v1/*` middleware. */
export function registerModelRoutes(app: Hono<{Variables: {userId: string; requestId: string}}>, models: OpenRouterModels) {
  app.get('/v1/model-key', async c => {
    const key = await models.keys.get(c.get('userId'));
    if (!key) throw new ApiError(404, 'not_found', 'No OpenRouter key is connected');
    c.header('Cache-Control', 'private, no-store');
    return c.json(key);
  });
  app.post('/v1/model-key', async c => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await models.keys.connect(c.get('userId'), await body(c, ModelKeyConnectInputSchema)));
  });
  app.post('/v1/model-key/check', async c => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(await models.keys.check(c.get('userId')));
  });
  app.delete('/v1/model-key', async c => {
    await models.keys.remove(c.get('userId'));
    return c.json({type: 'ok'});
  });
  app.get('/v1/models', async c => {
    const query = PageQuerySchema.parse(c.req.query()), pinned = c.req.query('pinned'), favorite = c.req.query('favorite');
    let items = await models.list(c.get('userId'));
    const q = query.q?.trim().toLowerCase();
    if (q) items = items.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    if (pinned === 'true') items = items.filter(m => m.pinned);
    if (favorite === 'true') items = items.filter(m => m.favorite);
    return c.json(page(items, query, `models:${q ?? ''}:${pinned ?? ''}:${favorite ?? ''}`));
  });
  app.patch('/v1/models/preferences', async c => {
    const input = await body(c, ModelPreferenceSchema);
    return c.json(await models.setPreference(c.get('userId'), input.modelId, {pinned: input.pinned, favorite: input.favorite}));
  });
}
