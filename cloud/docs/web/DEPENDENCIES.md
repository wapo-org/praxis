# Web & Glass Package Dependencies (`D15`)

Per architectural decision `D15` ("Dependencies are a liability. Prefer zero-dep or small focused libs over kitchen-sink frameworks. Document every added dependency in `cloud/docs/web/DEPENDENCIES.md` with a one-line reason"), here is the complete inventory of dependencies used by `@praxis/glass` (`cloud/packages/glass`) and `@praxis/web` (`cloud/apps/web`).

## Runtime Dependencies

| Package | Workspace | Version | One-Line Reason |
|---|---|---|---|
| `react` | `@praxis/web`, `@praxis/glass` (peer) | `^19.1.0` | Declarative UI component model, concurrent rendering, and hooks for the web SPA and glass primitives. |
| `react-dom` | `@praxis/web`, `@praxis/glass` (peer) | `^19.1.0` | DOM mounting, portal rendering for `GlassDropdown`, and server-side static markup rendering in tests. |
| `@praxis/protocol` | `@praxis/web` | `*` (workspace) | Shared TypeScript DTOs and Zod v1 wire-contract schemas between `apps/api`, `apps/web`, and iOS. |
| `@praxis/glass` | `@praxis/web` | `*` (workspace) | Reusable Snell's-law liquid glass surfaces, 6-band progressive blur scrims, and the improved `GlassDropdown` system. |

> **Zero external UI/state/markdown/icon bloat**:
> - **No Radix / Floating-UI / HeadlessUI**: `GlassDropdown` implements its own collision-aware portal positioning, in-place elevating submenu morph, `elementFromPoint` cross-row pointer/touch scrubbing, 2D `tanh` elastic drag, and 500+ item virtualized list in ~550 lines of zero-dependency TypeScript.
> - **No external state library (Redux / Zustand / TanStack Query)**: `PraxisStoreProvider` + `idb.ts` + `sse.ts` provide synchronous `localStorage`/IndexedDB cold-boot hydration, optimistic `clientTurnId` reconciliation, and resumable `Last-Event-ID` SSE streaming in pure React 19.
> - **No heavy Markdown AST / syntax highlighter bundle**: `AgentMessageView.tsx` implements a streaming-safe GFM block & inline chip parser (`CodePill`, `FileRef`, `LinkRef`, GFM tables, task lists, fenced code blocks) directly in TypeScript.

## Development & Build Dependencies

| Package | Workspace | Version | One-Line Reason |
|---|---|---|---|
| `vite` | `@praxis/web` | `^6.2.0` | Fast ESM dev server and Rollup-based production bundler for `cloud/apps/web`. |
| `@vitejs/plugin-react` | `@praxis/web` | `^4.3.4` | JSX/TSX transform and Fast Refresh support for Vite. |
| `@types/react` | `@praxis/web`, `@praxis/glass` | `^19.1.0` | Strict TypeScript type definitions for React 19 APIs. |
| `@types/react-dom` | `@praxis/web`, `@praxis/glass` | `^19.1.0` | Strict TypeScript type definitions for `react-dom/client` and `react-dom/server`. |
| `typescript` | `cloud` (root) | `^5.8.2` | Workspace-wide `strict: true` static type checking (`npm run typecheck`). |
| `vitest` | `cloud` (root) | `^3.0.9` | Fast unit and integration test runner across `@praxis/protocol`, `@praxis/api`, `@praxis/glass`, and `@praxis/web`. |
