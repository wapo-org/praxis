# Praxis Monorepo

- **Plans, roadmaps, and migration specs** live in Linear team `PRA` — do not add root plan/summary `.md` files to git.
- **Clean break pre-launch:** zero production users exist; delete superseded code, adapters, and corresponding sections of `cloud/ARCHITECTURE.md` / `cloud/docs/function-maps/*` in the same PR rather than adding backward-compatibility shims.
- **Verification (`cloud/`):**
  - `npm --prefix cloud run typecheck`
  - `npm --prefix cloud test`
- **Comment hygiene (`cloud/scripts/comment-sweep.mjs`):**
  - Keep comments to "why / invariant" (one sentence max, `<= 130` chars); avoid narrating what code does.
  - Check with `node cloud/scripts/comment-sweep.mjs check`.

## HARD Architectural Boundaries & Long-Term Maintainability

1. **Unidirectional layer & plugin boundaries:**
   - `cloud/packages/protocol`: pure Zod schemas, wire types, and protocol constants only; zero imports from `apps/*`, `convex/`, or runtime/provider SDKs. Define every API/event shape once here.
   - `cloud/packages/agent`: pure state machine interacting solely through injected ports (`Store`, `KV`, `Events`, `ModelProvider`, `Tool`); zero direct imports of Hono, Vercel, Convex, or Upstash.
   - `cloud/packages/credentials`: every multi-key or multi-account credential pool, HTTP cooldown, failover, and sticky placement MUST use `@praxis/credentials` — never ad-hoc key-rotation or retry loops.
   - `cloud/apps/api`: keep route handlers thin; route persistence, KV, and event streams through `AdapterBundle` (`contracts.ts`); mount capabilities (`mcp`, `tools`, `skills`, `voice`, `media`) as pluggable/unpluggable `FeatureModule` plugins (`modules.ts`).
   - Clients (`cloud/apps/web`, `PraxisChat/`): speak only to the server API / Convex boundary and consume shared tokens from `@praxis/glass` (`tokens.ts`, `tokens.css`) or `DesignSystem/Tokens.swift` + `Motion.swift`. Never import backend/provider SDKs or duplicate policy/secret logic.
2. **Constants & single source of truth (no magic literals):**
   - Static text, route paths, header/cookie names, error codes, KV/Redis key prefixes, timeouts, TTLs, size/count limits, and design tokens MUST be declared as named constants in the owning abstraction layer (`@praxis/protocol`, `@praxis/glass`, `Tokens.swift`, or feature/domain `constants.ts` modules) — never scattered inline.
   - Numeric limit, timeout, and budget constants should carry units in the name (`_MS`, `_SECONDS`, `_BYTES`, `_MAX`) and a 1-line invariant comment when non-obvious.
3. **Modularity, root-cause fixes & fail-closed behavior:**
   - Keep files cohesive and under ~400 lines; when editing oversized legacy files, extract cohesive modules rather than adding to the sprawl. Avoid compressed multi-statement single-line code.
   - Fix root causes rather than adding band-aid defensive fallbacks, `setTimeout` races, or duplicate validators.
   - Production adapters MUST fail closed (`503`/explicit error) and never silently degrade to in-memory stores, `dev-local` auth, or cleartext secrets.
4. **Type-system & boundary discipline:**
   - Parse untrusted inputs at system boundaries with Zod (TS) or `Codable` + explicit validation (Swift). Ban `v.any()` in `cloud/convex/` and raw `any` casts in TypeScript.
   - Make illegal states unrepresentable using discriminated unions, exhaustive switches, branded IDs (e.g., `TenantId` across external client boundaries), opaque redacted secret wrappers (`SealedSecret`), and structural capability/approval receipts rather than prose or regex heuristics.
5. **Security & isolation:**
   - Derive `userId`/owner exclusively from verified auth/session context — never trust client-supplied owner IDs in public endpoints.
   - Never log, return in API responses, or embed secrets/tokens in URLs, Redis keys, or telemetry.
   - Route user-supplied outbound URLs through SSRF-guarded `egress` fetch; ban `child_process`, `eval`, `new Function`, `vm`, and `worker_threads` in `cloud/apps/api`; classify unwrapped inner tool actions and propagate taint structurally.

See [infra/modal-pr-review/REVIEW_GUIDELINES.md](infra/modal-pr-review/REVIEW_GUIDELINES.md) for automated PR review sessions, Linear alignment checks, and review tone rules.
