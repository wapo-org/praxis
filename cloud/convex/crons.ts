import { cronJobs } from 'convex/server';
import { internal } from './_generated/api.js';
import { PENDING_EXPIRY_INTERVAL_MINUTES } from './composio/constants.js';
import { OUTPUT_SWEEP_INTERVAL_MINUTES } from './outputConstants.js';

const crons = cronJobs();

crons.interval(
  'expire pending composio connections',
  { minutes: PENDING_EXPIRY_INTERVAL_MINUTES },
  internal.composio.expire.expirePending,
  {},
);

crons.interval(
  'sweep orphaned tool outputs',
  { minutes: OUTPUT_SWEEP_INTERVAL_MINUTES },
  internal.outputs.sweep,
  {},
);

export default crons;
