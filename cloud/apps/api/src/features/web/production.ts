import {spillWebOutput} from './output.js';
import {pool, redisCooldownStore, type RedisLike} from '@praxis/credentials';
import {z} from 'zod';
import {WebSpendAdmissionSchema, WebSpendRequestSchema, WebSpendSettlementSchema, type WebSpendCall} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import type {ConvexRPC} from '../../adapters/convex.js';
import {assertPublicUrl} from '../../adapters/security.js';
import {WEB_PROVIDERS} from './constants.js';
import type {WebPorts} from './ports.js';

export function productionWebPorts(context: FeatureContext, rpc: ConvexRPC, redis: RedisLike,
  env: Record<string, string | undefined>): WebPorts {
  const periods = new Map<string, string>();
  const keyFor = (call: WebSpendCall) => JSON.stringify([call.runId, call.callId, call.service]);
  const addressed = (call: WebSpendCall) => {
    const period = periods.get(keyFor(call));
    if (!period) throw new Error('Missing web reservation period');
    return WebSpendRequestSchema.parse({...call, period});
  };
  return {
    pools: {exa: pool(WEB_PROVIDERS.exa.name, env, {service: WEB_PROVIDERS.exa.service}),
      firecrawl: pool(WEB_PROVIDERS.firecrawl.name, env, {service: WEB_PROVIDERS.firecrawl.service})},
    cooldowns: redisCooldownStore(redis), fetch: context.fetch, egress: context.egress,
    assertPublicUrl: url => assertPublicUrl(url, {allowHttp: true}), cache: context.kv,
    accounting: {
      async reserve(call) {
        const request = WebSpendRequestSchema.parse({...call, period: new Date().toISOString().slice(0, 7)});
        const result = WebSpendAdmissionSchema.parse(await rpc.action('webTools:reserve', {request}));
        if (result === 'reserved') periods.set(keyFor(call), request.period);
        return result;
      },
      async admitAttempt(call) {
        return z.boolean().parse(await rpc.action('webTools:attempt', {request: addressed(call)}));
      },
      async settle(charge) {
        const request = WebSpendSettlementSchema.parse({...charge, period: addressed(charge).period});
        await rpc.action('webTools:settle', {request});
        periods.delete(keyFor(charge));
      },
      async release(call) {
        await rpc.action('webTools:release', {request: addressed(call)});
        periods.delete(keyFor(call));
      },
    },
    spill: input => spillWebOutput(context.store, input),
  };
}
