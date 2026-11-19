import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** `cloud/`: every command runs from here, as CI does. */
export const CLOUD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const REPO_DIR = resolve(CLOUD_DIR, '..');
export const ARTIFACTS_DIR = join(CLOUD_DIR, 'artifacts');
export const FEATURE_MAP_PATH = join(CLOUD_DIR, 'verify', 'feature-map.json');
export const LIVE_SUITES_DIR = join(CLOUD_DIR, 'verify', 'live');

/** Away from the dev defaults (5173/8787) and the Modal reviewer (5173/8797), so a run never collides with a dev server. */
export const DEFAULT_WEB_PORT = 5240;
export const DEFAULT_API_PORT = 8860;
export const LOOPBACK_HOST = '127.0.0.1';
/** Set by browser setup for every Playwright worker: the isolated auth deployment tests create accounts in. */
export const PW_CONVEX_URL_ENV = 'PW_CONVEX_URL';
export const PW_AUTH_CHALLENGE_BUDGET_ENV = 'PW_AUTH_CHALLENGE_BUDGET_DIR';
export const PW_WORKER_SESSIONS_ENV = 'PW_WORKER_SESSIONS_DIR';

/** Cold vite + tsx start on a busy laptop stays well under this. */
export const SERVER_READY_TIMEOUT_MS = 60_000;
export const SERVER_POLL_INTERVAL_MS = 250;
/** Grace between SIGTERM and SIGKILL when stopping our own process groups. */
export const SERVER_STOP_GRACE_MS = 3_000;
/** One viewport for every captured page, so verify flows and praxis-browser screenshots compare. */
export const CAPTURE_VIEWPORT = {width: 1280, height: 860} as const;
export const FLOW_ACTION_TIMEOUT_MS = 10_000;
export const FLOW_TIMEOUT_MS = 60_000;
export const API_REQUEST_TIMEOUT_MS = 30_000;
/** Lines of a failing step's output echoed to the terminal; the full log stays in the artifacts. */
export const FAILURE_TAIL_LINES = 40;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
/** Live suite finished without failures but with skipped or pending steps: not a proof yet. */
export const EXIT_INCOMPLETE = 3;
