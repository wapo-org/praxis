# Clerk and account sync

Production now requires CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY and CLERK_JWT_KEY
(the instance's PEM public key). Set VITE_CLERK_PUBLISHABLE_KEY on the web build.
Enable email/password, email verification codes, password reset, Google and Apple
in the Clerk instance. The custom form uses Clerk hooks; no hosted sign-in UI.
Verification uses @clerk/backend verifyToken with the PEM and authorizedParties
from PRAXIS_WEB_ORIGINS, with no JWKS network request. The backend user lookup
on first binding obtains the primary **verified** email; browser-supplied email
and JWT custom email claims never authorize migration. Keep the PEM updated on
Clerk signing-key rotation. No keys are needed for local development.

## Migration

Deploy convex/authClerk.ts with the existing Convex schema before switching API
auth. Keep a database backup. On first Clerk login the server atomically binds
the Clerk subject to the legacy user with the same case-insensitive verified
email, retaining that Praxis user ID. All chats, messages, runs, settings and
attachments remain under their original owner. Subsequent sessions look up the
binding and cannot move it if the Clerk email changes. Ambiguous legacy emails,
a deleting legacy account, or an email already bound to a different Clerk user
fail closed and require operator resolution. Existing Better Auth sessions need
to sign in again. Its adapter remains only for migration/conformance tests;
production no longer accepts Better Auth credentials or needs BETTER_AUTH_SECRET.

Account deletion requires a Clerk first-factor authentication less than five
minutes old (`fva`, not JWT `iat`). Sign out and back in before deletion. The
backend deleteUser interface is called before the existing durable Praxis purge;
a failed provider deletion prevents the purge, preserving retryability.

## Sync rules

The existing cursor/Merkle protocol remains. GET /v1/sync/events sends finite
25-second SSE streams from the durable revision log. Web reconnects using the
last applied cursor, with a one-second retry after transport errors. The first
connection starts after the authoritative bootstrap revision and loads account
settings from GET /v1/sync/settings. Reconnect resumes the last applied revision.
Existing per-run SSE subscriptions supply live text and stop/approval updates.
Offline/sleep recovery is independent of the ephemeral user-event retention.
Chat order is pinned-first, then descending server updatedAt, as in the UI.

PATCH /v1/sync/settings stores one accountSetting row per field: theme, palette,
button, provider, model, effort. Last server commit wins within each field;
unrelated fields never overwrite one another. localStorage remains the first
paint cache; the durable server rows take over after catch-up.

Offline chat creation, rename, pin, delete and settings edits use an account/API
scoped localStorage outbox, replayed in FIFO order when online. Incoming chat
rows are held while that chat has queued edits; the replay response and following
revision restore the merged current server row. Queued PATCH against a deleted
chat is discarded, never resurrecting it. Retried create uses a stable client ID;
a 409 means that ID already committed. Network errors retain the queue. Offline
message sends and drafts are not queued by this change.

## iOS

The frozen iOS app is untouched. It needs a Clerk native session/token driver,
Bearer JWTs on API and SSE requests (refresh before reconnect), a replica applying
cursor batches transactionally including tombstones, the same field settings
rows and durable FIFO offline outbox. Existing run SSE/snapshot endpoints provide
streaming catch-up and cross-device cancel. Use packages/sync test vectors for
hash/cursor conformance. The old Better Auth sign-in endpoint now returns 410.

## Verification limits

All local tests use fake Clerk or local dev auth. No real account, keys, email,
OAuth provider or live Clerk instance was used. Live Clerk configuration and
Apple/Google redirect/session-task policy require the owner's later keyed check.
