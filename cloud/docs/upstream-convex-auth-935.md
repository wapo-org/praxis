# Upstream Convex Auth #935

Proposed comment. This text has not been posted.

> Thanks for documenting this. Could this request also cover the Google and Apple provider components? When an app deletes a user, it needs to remove every provider-account mapping owned by that user, not only password and verified-email state. Both providers use the shared provider-function implementation and store account rows with a `userId`. A supported, idempotent `provider.deleteUser({ userId })` mutation on each provider component would let applications remove those mappings. Could the core component expose one documented deletion helper that invokes these provider-local deletes along with password, email, and session cleanup, or should applications call each component's delete mutation themselves? Each provider delete should remove only rows for the supplied user and leave other users' mappings intact.

Local evidence: `cloud/convex/auth.ts` configures Google and Apple user creation callbacks; `cloud/convex/account.ts` invokes provider-local `deleteUser` mutations; and `cloud/patches/@convex-dev+auth+2.0.0.patch` adds a `userId` index and deletion implementation to the shared OAuth provider functions.
