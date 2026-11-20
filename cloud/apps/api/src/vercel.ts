import {waitUntil} from './wait-until.js';
import {handle} from 'hono/vercel';
import {createProductionApp} from './production.js';

/** Vercel handler; PRAXIS_LOCAL_SMOKE=1 uses memory adapters locally and fails closed in production. */
async function build() {
  if (process.env.PRAXIS_LOCAL_DATA_DIR !== undefined) throw new Error("PRAXIS_LOCAL_DATA_DIR is only supported by dev:local, never Vercel");
  if (process.env.PRAXIS_LOCAL_SMOKE === '1') {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') throw new Error('PRAXIS_LOCAL_SMOKE is not allowed in production');
    const {createSmokeApp} = await import('./smoke.js');
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
