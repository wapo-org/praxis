import {WORKSPACE_ROOT} from '../constants.js';

/** PRA-19 defaults: 10 minutes idle, 2 hours lifetime, 1 CPU and 2 GiB; limits equal requests so PRA-22 can bound cost. */
export const SANDBOX_RESOURCES = {
  IDLE_TIMEOUT_MS: 600_000,
  LIFETIME_MS: 7_200_000,
  CPU_CORES: 1,
  MEMORY_MIB: 2_048,
} as const;

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
