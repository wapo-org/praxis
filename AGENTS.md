# Praxis Monorepo

- **Plans, roadmaps, and migration specs** live in Linear team `PRA` — do not add root plan/summary `.md` files to git. New `*.md` at the repo root or under `cloud/` must be named `README`, `AGENTS`, `ARCHITECTURE`, `DEPLOY`, `PROTOCOL` or `DESIGN`, or live in `cloud/docs/**`. `[R5.docs-commit]`
- **Clean break pre-launch:** zero production users exist; delete superseded code, adapters, and corresponding sections of `cloud/ARCHITECTURE.md` / `cloud/docs/function-maps/*` in the same PR rather than adding backward-compatibility shims.
- **Verification (`cloud/`):** `npm --prefix cloud run verify -- gate` runs this whole list, one result line per step (`--json` for machines):
  - `npm --prefix cloud run typecheck`
  - `npm --prefix cloud test`
  - `npm --prefix cloud run check:rules` (mechanical rules below; see `cloud/scripts/check-rules.mjs`)
  - `npm --prefix cloud run lint` (oxlint, see **Lint** below)
  - `node cloud/scripts/comment-sweep.mjs check`
  - `npm --prefix cloud run build -w @praxis/web` and `-w @praxis/api`
- **Behaviour checks:** `verify -- web` (Playwright flows: accessibility snapshot, screenshot, fail on console errors or unlisted 4xx/5xx), `verify -- api`, `verify -- ios` (macOS), `verify -- map --check`. Every flow, check and live suite is owned by a feature in `cloud/verify/feature-map.json`; add the entry with the code. Live checks: `verify -- live <suite>` writes a redacted `proof.json` (contract in `cloud/packages/verify/README.md`).
- **Comment hygiene (`cloud/scripts/comment-sweep.mjs`):**
  - Keep comments to "why / invariant" (one sentence max, `<= 130` chars); avoid narrating what code does.
  - A lone `//` line whose every word is already on the next code line (`// user id` above `const userId`) fails `check:rules`: delete it, or say why. `[R3.narrating-comment]`

## HARD Architectural Boundaries & Long-Term Maintainability

Rules tagged `[R…]` are enforced by `check:rules` against a ratchet baseline: existing violations are listed in `cloud/scripts/check-rules.baseline.json`, new ones fail, and the baseline may only shrink.

1. **Unidirectional layer & plugin boundaries:**
   - `cloud/packages/protocol`: pure Zod schemas, wire types, and protocol constants only; zero imports from `apps/*`, `convex/`, or runtime/provider SDKs. Define every API/event shape once here. `[R1.protocol-imports]`
   - `cloud/packages/agent` — *valid until PRA-14 lands:* pure state machine interacting solely through injected ports (`Store`, `KV`, `Events`, `ModelProvider`, `Tool`); zero direct imports of Hono, Vercel, Convex, or Upstash. `[R1.agent-imports]`
     *Target (PRA-14, LangChain `createDeepAgent`):* the agent harness depends on LangChain/DeepAgents only and reaches everything else through injected ports — still no Convex, Vercel, or Upstash imports.
   - `cloud/packages/credentials`: every multi-key or multi-account credential pool, HTTP cooldown, failover, and sticky placement MUST use `@praxis/credentials` — never ad-hoc key-rotation or retry loops. `[R1.credentials-pool]`
   - `cloud/apps/api` — *valid until PRA-13 / PRA-41 land:* keep route handlers thin; route persistence, KV, and event streams through `AdapterBundle` (`contracts.ts`); mount capabilities (`mcp`, `tools`, `skills`, `voice`, `media`) as pluggable/unpluggable `FeatureModule` plugins (`modules.ts`).
     *Target (PRA-13, PRA-41):* everything a client calls is a Convex function; Vercel keeps only a stateless `/api/turn` worker. Identity comes only from `getAuthUserId` (Convex) or a Convex-signed request (worker) — do not add new public Hono routes or `FeatureModule`s.
   - Clients (`cloud/apps/web`, `PraxisChat/`): speak only to the server API / Convex boundary and consume shared tokens from `@praxis/glass` (`tokens.ts`, `tokens.css`) or `DesignSystem/Tokens.swift` + `Motion.swift`. Never import backend/provider SDKs or duplicate policy/secret logic. `[R1.web-imports]`
   - `cloud/apps/web/src/components/**`: no raw `useEffect`/`useLayoutEffect`, `setTimeout`, `setInterval`, `requestAnimationFrame` or `requestIdleCallback`. Put the effect or timer in a `use*` hook under `apps/web/src/hooks/` (or `lib/`, `state/`) and call that hook from the component. `[R1.web-effects]`
   - *Off until PRA-13:* `cloud/apps/api` must not import `@praxis/agent` (`[R1.api-imports-agent]`; count today's hits with `check:rules -- --all --enable R1.api-imports-agent`).
2. **Constants & single source of truth:**
   - Values that another layer, the wire protocol, or ops depend on — error codes, route paths, header/cookie names, KV/Redis key prefixes, timeouts/TTLs, size/count limits, and design tokens — MUST be named constants in the owning layer (`@praxis/protocol`, `@praxis/glass`, `Tokens.swift`, or a feature/domain `constants.ts`). UI copy and one-off local literals stay in the component that uses them.
   - Numeric limit, timeout, and budget constants should carry units in the name (`_MS`, `_SECONDS`, `_BYTES`, `_MAX`) and a 1-line invariant comment when non-obvious.
3. **Modularity, style, root-cause fixes & fail-closed behavior:**
   - Keep files cohesive and under ~400 lines; when editing oversized legacy files, extract cohesive modules rather than adding to the sprawl. `[R3.file-length]`
   - New and touched functions are multi-line and readable, even inside a compressed legacy file — this overrides "match the surrounding style". Do not reformat whole legacy files: diffs must stay reviewable.
   - Fix root causes rather than adding band-aid defensive fallbacks, `setTimeout` races, or duplicate validators.
   - Production adapters MUST fail closed (`503`/explicit error) and never silently degrade to in-memory stores, `dev-local` auth, or cleartext secrets. Fail-open or degraded behavior is allowed only where a Linear issue decides it explicitly — today: Redis cooldown state (PRA-61) and the last-good model catalogue (PRA-59). Everything else fails closed.
4. **Type-system & boundary discipline:**
   - Parse untrusted inputs at system boundaries with Zod (TS) or `Codable` + explicit validation (Swift). Ban `v.any()` in `cloud/convex/` and raw `any` in TypeScript, tests included. `[R4.no-any]` `[R4.convex-v-any]`
   - Make illegal states unrepresentable using discriminated unions, exhaustive switches, branded IDs, opaque redacted secret wrappers, and structural capability/approval receipts rather than prose or regex heuristics.
   - `@praxis/types` (`cloud/packages/types`, zero dependencies) owns both wrappers — do not invent ad-hoc versions of either:
     - `SealedSecret`: key material in memory. Wrap with `SealedSecret.of(value)` the moment a key is unsealed or read from env; call `.reveal()` only where the value is consumed (an `Authorization` header, a cipher input). `toString`, `toJSON` and `util.inspect` print `[redacted]`. In use for the OpenRouter model key and every `@praxis/credentials` pool value.
     - `TenantId`: the only owner identifier external services (Composio, Mem0, Modal, PostHog, Redis keys) may receive; get one from `deriveTenantId(userId, secret)` (HMAC-SHA256). Not wired into integrations yet — PRA-36 does that and then enables `[R4.tenant-id-boundary]` (off until then).
5. **Security & isolation:**
   - Derive `userId`/owner exclusively from verified auth/session context — never trust client-supplied owner IDs in public endpoints; public Convex functions take no `userId`/`ownerId` argument. `[R5.client-owner-arg]`
   - Never log, return in API responses, or embed secrets/tokens in URLs, Redis keys, or telemetry.
   - Route user-supplied outbound URLs through SSRF-guarded `egress` fetch; ban `child_process`, `eval`, `new Function`, `vm`, and `worker_threads` in `cloud/apps/api` `[R5.banned-primitives]`; classify unwrapped inner tool actions and propagate taint structurally.

## Lint

- **TypeScript/React — oxlint** (`cloud/.oxlintrc.json`, pinned version, `npm --prefix cloud run lint`). Every rule that is on is an error and has zero violations; fix the code, never add a disable comment or switch a rule off. oxlint prints a `help:` line with the fix; the rules we chose on top of its `correctness` set:
  - `no-unused-vars`: delete the import/variable; prefix an intentionally unused parameter with `_`.
  - `eqeqeq`: use `===`/`!==`; only `== null` / `!= null` is allowed (matches both `null` and `undefined`).
  - `no-self-compare`: compare against the other value you meant, or delete the tautology.
  - `no-throw-literal`: `throw new Error('…')` (or `ApiError`), never a bare value.
  - `preserve-caught-error`: when re-throwing inside `catch (error)`, pass `{cause: error}`.
  - `no-unused-expressions`: write `if (a) b(); else c();` instead of a ternary or `&&` used as a statement.
  - `radix`: `Number.parseInt(text, 10)`.
  - `no-eval`, `no-var`: use a parser or a lookup table; use `const`/`let`.
  - `no-console` (only `apps/web/src`): remove `console.log`/`debug`/`info`; `console.warn`/`console.error` stay allowed.
  - `vitest/expect-expect`, `vitest/valid-title`: every test asserts something; titles are strings or the suite's `name` argument.
- **Swift — SwiftLint** (`.swiftlint.yml`, correctness rules only, run in CI by `apple.yml` with `--strict --baseline PraxisChat/.swiftlint-baseline.json`). Existing violations live in the baseline; a new one fails. Fix it rather than adding `// swiftlint:disable`.

## Linear: Live Check & findings (every agent)

- **Live Check.** Work that was not verified against real services (real API keys, a real device, a hosted deploy) is not Done. List exactly what still needs a live check in your report; the issue moves to **Live Check** with one `Live check: PRA-n …` sub-issue carrying that checklist, and the parent is Done only after the sub-issue closes.
- **Findings go where they apply.** When you discover something that affects *another* Linear issue (a wrong assumption in its plan, a missing step, a dependency, a risk, code it will have to touch), comment on **that** issue: `**Finding from <task> (<date>)**`, what you found, evidence (`path:line`, command output), and what the plan should change. One comment per finding; facts only; no secrets. Questions about your own task go in your report, not on your own issue. List every comment URL in your report.

See [infra/pr-review/REVIEW_GUIDELINES.md](infra/pr-review/REVIEW_GUIDELINES.md) for automated PR review sessions, Linear alignment checks, and review tone rules.
