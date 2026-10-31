/**
 * Key rotation: re-seal every stored secret with the current key.
 *   PRAXIS_ENCRYPTION_KEYS="<new>,<old>" CONVEX_URL=… PRAXIS_CONVEX_SERVER_TOKEN=… npx tsx scripts/reencrypt.ts [--dry-run]
 * Prints counts only (never values). Exit code 1 if any value could not be opened with the configured keys.
 */
import {createConvexStore} from '../src/adapters/convex.js';
import {reencryptAll} from '../src/reencrypt.js';

const ring = process.env.PRAXIS_ENCRYPTION_KEYS ?? process.env.PRAXIS_ENCRYPTION_KEY;
if (!ring || !process.env.CONVEX_URL || !process.env.PRAXIS_CONVEX_SERVER_TOKEN) {
  console.error('Set PRAXIS_ENCRYPTION_KEYS (current first), CONVEX_URL and PRAXIS_CONVEX_SERVER_TOKEN.');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const store = createConvexStore({url: process.env.CONVEX_URL, serverToken: process.env.PRAXIS_CONVEX_SERVER_TOKEN});
const stats = await reencryptAll(store, store.owners(), ring, dryRun);
console.info(JSON.stringify({type: 'reencrypt', dryRun, ...stats}));
process.exit(stats.failed ? 1 : 0);
