import {httpRouter} from 'convex/server';
import {httpAction} from './functions.js';
import {upload} from './uploads.js';
import {COMPOSIO_WEBHOOK_PATH} from './composio/constants.js';
import {composioWebhook} from './composio/webhookRoute.js';
const http = httpRouter();
const cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'};
http.route({pathPrefix: '/uploads/', method: 'POST', handler: httpAction(async (ctx, request) => {
  const response = await upload(ctx, request);
  for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
  response.headers.set('Cache-Control', 'no-store');
  return response;
})});
http.route({pathPrefix: '/uploads/', method: 'OPTIONS', handler: httpAction(async () => new Response(null, {status: 204, headers: cors}))});
http.route({path: COMPOSIO_WEBHOOK_PATH, method: 'POST', handler: composioWebhook});
export default http;
