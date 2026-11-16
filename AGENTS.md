# Praxis Monorepo

- **Plans, roadmaps, and migration specs** live in Linear team `PRA` — do not add root plan/summary `.md` files to git.
- **Clean break pre-launch:** zero production users exist; delete superseded code, adapters, and corresponding sections of `cloud/ARCHITECTURE.md` / `cloud/docs/function-maps/*` in the same PR rather than adding backward-compatibility shims.
- **Verification (`cloud/`):**
  - `npm --prefix cloud run typecheck`
  - `npm --prefix cloud test`
- **Comment hygiene (`cloud/scripts/comment-sweep.mjs`):**
  - Keep comments to "why / invariant" (one sentence max); avoid narrating what code does.
  - Check with `node cloud/scripts/comment-sweep.mjs check`.
