/** One `store:list` page; the API adapter follows the cursor, so no single query reads an unbounded range. */
export const STORE_LIST_PAGE_MAX = 200;
/** One `chats:list` page for clients. */
export const CHAT_PAGE_MAX = 100;
/** One row per Composio toolkit; far above any real user, so hitting it means a bug, not a long list. */
export const CONNECTIONS_PER_USER_MAX = 200;
/** Every ledger row of one turn: its response plus one row per tool call. */
export const LEDGER_ROWS_PER_TURN_MAX = 1_000;
/** Convex Auth links at most a handful of OAuth emails to one user. */
export const OAUTH_EMAILS_PER_USER_MAX = 100;
