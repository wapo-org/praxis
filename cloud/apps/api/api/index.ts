import {waitUntil} from '../src/wait-until.js';
import {handle} from 'hono/vercel';
import {createProductionApp} from '../src/production.js';

/**
 * Vercel Node function (Fluid compute). Production composition only; `PRAXIS_LOCAL_SMOKE=1` swaps in memory
 * adapters for the local bundle smoke test and is refused whenever VERCEL or NODE_ENV=production is set.
 */
async function build() {
  if (process.env.PRAXIS_LOCAL_SMOKE === '1') {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('PRAXIS_LOCAL_SMOKE is not allowed in production');
    const {createSmokeApp} = await import('../src/smoke.js');
    return createSmokeApp();
  }
  return createProductionApp(process.env, {defer: waitUntil}).app;
}

const app = await build();
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
export default app;
