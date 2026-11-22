import {describe, expect, it} from 'vitest';
import {convexTest} from 'convex-test';
import {makeFunctionReference} from 'convex/server';
import schema from '../../../../../convex/schema.js';
import {createPraxisApp} from '../../server.js';
import {createMemoryAdapters} from '../../adapters/memory.js';
import {storeFromRPC, type ConvexRPC} from '../../adapters/convex.js';
import {featureModules} from '../../modules.js';
import {toolsStorageFromRPC} from './convex-storage.js';

const SERVER_TOKEN = 'upload-route-server-credential-with-32-characters';
const SESSION_TOKEN = 'Bearer upload-route-session';

/** The production wiring for `/v1/uploads`: Convex Store and tools storage behind a verified session owner. */
async function uploadWorld() {
  process.env.PRAXIS_CONVEX_SERVER_TOKEN = SERVER_TOKEN;
  process.env.CONVEX_SITE_URL = 'https://happy-otter-123.convex.site';
  const t = convexTest(schema, {
    '../../../../../convex/_generated/api.js': async () => ({}),
    '../../../../../convex/functions.ts': () => import('../../../../../convex/functions.js'),
    '../../../../../convex/store.ts': () => import('../../../../../convex/store.js'),
    '../../../../../convex/files.ts': () => import('../../../../../convex/files.js'),
    '../../../../../convex/uploads.ts': () => import('../../../../../convex/uploads.js'),
    '../../../../../convex/http.ts': () => import('../../../../../convex/http.js'),
  });
  const rpc: ConvexRPC = {
    query: (name, args) => t.query(makeFunctionReference<'query'>(name), {...args, serverToken: SERVER_TOKEN}),
    mutation: (name, args) => t.mutation(makeFunctionReference<'mutation'>(name), {...args, serverToken: SERVER_TOKEN}),
    action: (name, args) => t.action(makeFunctionReference<'action'>(name), {...args, serverToken: SERVER_TOKEN}),
  };
  const owner = await t.run(ctx => ctx.db.insert('users', {}));
  const storage = toolsStorageFromRPC(rpc, 'https://api.example.com');
  const {app} = createPraxisApp({
    adapters: {...createMemoryAdapters(), store: storeFromRPC(rpc)},
    local: true,
    resolveSession: async request => {
      if (request.headers.get('authorization') !== SESSION_TOKEN) return null;
      return {user: {type: 'user', id: owner, name: 'Uploader'}, expiresAt: new Date().toISOString()};
    },
    modules: service => featureModules(service, {storage}),
  });
  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST',
    headers: {authorization: SESSION_TOKEN, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  return {t, owner, post};
}

describe('Convex uploads through the API route', () => {
  it('creates a ticket from the full wire request, uploads the bytes and completes the attachment', async () => {
    const {t, post} = await uploadWorld();
    const request = {type: 'upload.request', clientAttachmentId: 'client-1', name: 'note.txt', mediaType: 'text/plain', size: 5};

    const ticket = await post('/v1/uploads', request);
    expect(ticket.status).toBe(200);
    const {uploadUrl} = await ticket.json();
    const upload = await t.fetch(new URL(uploadUrl).pathname, {method: 'POST', headers: {'content-type': 'text/plain'}, body: 'hello'});
    expect(upload.status).toBe(200);
    const {storageId} = await upload.json();

    const complete = await post('/v1/uploads/complete', {...request, type: 'upload.complete', storageId});
    expect(complete.status).toBe(201);
    expect(await complete.json()).toMatchObject({type: 'attachment', name: 'note.txt', size: 5});
  });

  it('refuses a new upload once the owner account deletion has begun', async () => {
    const {t, owner, post} = await uploadWorld();
    await t.run(ctx => ctx.db.patch(owner, {deleting: true}));
    const ticket = await post('/v1/uploads', {type: 'upload.request', name: 'note.txt', mediaType: 'text/plain', size: 5});
    expect(ticket.status).not.toBe(200);
    expect(await t.run(ctx => ctx.db.query('files').collect())).toEqual([]);
  });
});
