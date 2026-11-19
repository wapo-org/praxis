/** Composio webhook subscription URL is `${CONVEX_SITE_URL}${COMPOSIO_WEBHOOK_PATH}`; ops configures it in Composio. */
export const COMPOSIO_WEBHOOK_PATH = '/composio/webhook';
export const COMPOSIO_WEBHOOK_SECRET_ENV = 'COMPOSIO_WEBHOOK_SECRET';

export const WEBHOOK_ID_HEADER = 'webhook-id';
export const WEBHOOK_TIMESTAMP_HEADER = 'webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'webhook-signature';

/** Matches the Composio SDK's default replay window; applies to both past and future timestamps. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Composio payloads are a few KiB; anything larger is rejected before parsing. */
export const WEBHOOK_BODY_BYTES_MAX = 256 * 1024;
/** Caps HMAC work per request; key rotation sends at most a handful of signatures. */
export const WEBHOOK_SIGNATURES_MAX = 8;

/** Rows deleted per cron run, so one run stays well inside a mutation's read/write limits. */
export const PENDING_EXPIRY_BATCH_MAX = 200;
export const PENDING_EXPIRY_INTERVAL_MINUTES = 15;
