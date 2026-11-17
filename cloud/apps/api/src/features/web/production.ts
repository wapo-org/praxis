import {spillWebOutput} from './output.js';
import {pool, redisCooldownStore, type RedisLike} from '@praxis/credentials';
import {z} from 'zod';
import type {FeatureContext} from '../../contracts.js';
import type {ConvexRPC} from '../../adapters/convex.js';
import {assertPublicUrl} from '../../adapters/security.js';
import {WEB_PROVIDERS} from './constants.js';
import type {WebPorts, WebSpendInput} from './ports.js';

export function productionWebPorts(context: FeatureContext, rpc: ConvexRPC, redis: RedisLike,
  env: Record<string, string | undefined>): WebPorts {
  const periods = new Map<string, string>();
  const keyFor = (input: WebSpendInput) => JSON.stringify([input.runId, input.callId, input.service]);
  const addressed = (input: WebSpendInput) => {
    const period = periods.get(keyFor(input));
    if (!period) throw new Error('Missing web reservation period');
    return {...input, period};
  };
  return {
    pools: {exa: pool(WEB_PROVIDERS.exa.name, env, {service: WEB_PROVIDERS.exa.service}),
      firecrawl: pool(WEB_PROVIDERS.firecrawl.name, env, {service: WEB_PROVIDERS.firecrawl.service})},
    cooldowns: redisCooldownStore(redis), fetch: context.fetch, egress: context.egress,
    assertPublicUrl: url => assertPublicUrl(url, {allowHttp: true}), cache: context.kv,
    accounting: {
      async reserve(input) {
        const period = new Date().toISOString().slice(0, 7);
        const result = z.enum(['reserved', 'denied', 'duplicate']).parse(await rpc.action('webTools:reserve', {request: {...input, period}}));
        if (result === 'reserved') periods.set(keyFor(input), period);
        return result;
      },
      async admitAttempt(input) {
        return z.boolean().parse(await rpc.action('webTools:attempt', {request: addressed(input)}));
      },
      async settle(input) {
        const {payer: _payer, ...settlement} = input;
        await rpc.action('webTools:finish', {request: {...addressed(input), actualMicroUsd: settlement.actualMicroUsd, slot: settlement.slot}});
        periods.delete(keyFor(input));
      },
      async release(input) {
        await rpc.action('webTools:finish', {request: addressed(input)});
        periods.delete(keyFor(input));
      },
    },
    spill: input => spillWebOutput(context.store, input),
  };
}
