import type {SandboxRefusalReason} from '@praxis/protocol';
import {WORKSPACE_ROOT} from '../constants.js';

/** The Volume is the workspace; the sandbox's own disk holds nothing that must survive a reboot. */
export const SANDBOX_VOLUME_MOUNT = WORKSPACE_ROOT;

/** One Modal App per account groups every Praxis sandbox, so names are unique across owners within it. */
export const SANDBOX_APP_NAME = 'praxis-sandboxes';

/** A cold caller waits this long for another caller's boot before reporting "still starting". */
export const SANDBOX_WAIT_MAX_MS = 90_000;
/** First exec after create; it proves the container runs and the Volume is mounted. */
export const SANDBOX_READY_TIMEOUT_MS = 60_000;
/** How soon a model may retry after a failed boot. */
export const SANDBOX_BOOT_RETRY_MS = 5_000;

export const SANDBOX_MESSAGES = {
  unavailable: 'The sandbox is temporarily unavailable.',
  bootFailed: 'The sandbox failed to start.',
  starting: 'The sandbox is still starting.',
} as const;

/** Free-tier refusals (PRA-170): what the user sees beside the retry time; no slot or account is ever named. */
export const SANDBOX_REFUSAL_MESSAGES: Record<SandboxRefusalReason, string> = {
  live_limit: 'Another sandbox is still running for this account; the free tier runs one at a time.',
  slot_busy: 'Sandboxes are busy right now.',
  daily_cap: 'The free tier\'s daily sandbox time is used up.',
  monthly_cap: 'The free tier\'s monthly sandbox time is used up.',
  allowance: 'This month\'s included usage is used up.',
};
