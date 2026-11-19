import { cronJobs } from 'convex/server';
import { internal } from './_generated/api.js';
import { PENDING_EXPIRY_INTERVAL_MINUTES } from './composio/constants.js';

const crons = cronJobs();

crons.interval(
  'expire pending composio connections',
  { minutes: PENDING_EXPIRY_INTERVAL_MINUTES },
  internal.composio.expire.expirePending,
  {},
);

export default crons;
