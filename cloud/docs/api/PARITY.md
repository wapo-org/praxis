# Cloud API ↔ Swift runtime parity

Reference: `Packages/PraxisAgent/Sources/**` (frozen) and the app wiring in `PraxisChat/PraxisChat/{Agent,App,Services}`.
Cloud paths are relative to `cloud/`. Audited 2026-10-31 (WP-A7). Status values: **done**, **partial**, **missing**, **dropped** (intentionally not ported).

| Capability | Swift ref | Cloud ref | Status |
|---|---|---|---|
| **Tools** | | | |
| `load_skill`, `read_skill_file` | AgentSkills/SkillTools.swift | apps/api/src/features/tools/builtin.ts | done |
| `save_skill`, `delete_skill` (agent-created only, scripts dropped) | AgentSkills/SkillAuthoringTools.swift | features/tools/authoring.ts | done |
| `run_javascript`: QuickJS, time and memory limits | AgentJS/QuickJSRunner.swift | features/tools/sandbox.ts (quickjs-emscripten) | done |
| JS `fetch`: GET/HEAD only in plan mode, per-host consent, SSRF guard | AgentJS/Fetch.swift | sandbox.ts:29, tools/http.ts (`ctx.egress`, pinned) | done |
| JS persistent kv, attachment file scoping (`fs`, hidden-from-code) | AgentJS/JSSession.swift | sandbox.ts + builtin.ts `javascriptTool` | done |
| JS nested tool calls through policy | RunJavaScriptTool.swift | sandbox `tools.<name>` → `execution.callTool` | done |
| `look_at_image` (vision fallback), with crop | AgentRuntime/ImageReading.swift | packages/agent/src/image-reader.ts, modules.ts `visionTools`, tools/image-crop.ts | done |
| Spilled tool output + `read_tool_output` | AgentCore/Tools/ToolRegistry.swift | runner spill → `output` rows; execution.ts `readToolOutputTool` | done (WP-A7) |
| **Skills** | | | |
| Catalog in the frozen system prompt + "new skills" turn notes | SkillCatalog.swift, TurnNotes.swift | apps/api/src/conversation.ts | done |
| Skill CRUD | SkillStore.swift | features/tools/index.ts `/skills` | done |
| Bundled skill files (read) | SkillFiles.swift | tools/state.ts, convex/tools.ts | done |
| Skill registries: search, install, digest check | Registry/SkillRegistryClient.swift | features/tools/registries.ts | done |
| Registry update checks (installed skill has a newer version) | Registry/SkillRegistry.swift `RegistryUpdate` | features/tools/registries.ts `/skills/updates`, `/:id/update` | done (WP-A8) |
| Import a skill from a .zip/.tar archive | SkillImporter.swift, ZipArchive/TarArchive.swift | features/tools/import.ts `/skills/import` | done (WP-A8) |
| **MCP** | | | |
| Streamable HTTP + legacy SSE transports | MCPClient.swift, LegacySSEChannel.swift | features/mcp/client.ts (official SDK) | done |
| OAuth 2.1: PKCE, DCR, CIMD, token refresh, re-auth on revoked grant | MCPAuth.swift | features/mcp/oauth.ts, refresh.ts | done |
| Tools, frozen per conversation, qualified names | MCPTool.swift, AgentRuntime.swift | features/mcp/tools.ts | done |
| Gateway trio above 30 tools (`mcp_search_tools`/`describe`/`call`) | MCPGateway.swift, ConversationSetup.gatewayThreshold | tools.ts `createMcpGateway`, modules.ts `withGateway` | done (WP-A7) |
| Resources as model tools (list/read) | MCPResourceTools.swift | features/mcp/resources.ts (one pair per server) | done (WP-A7) |
| Resources/prompts in the UI (list, read, get prompt) | MCPServerFeatures.swift | `/v1/connectors/:id/{resources,prompts}` | done |
| Resource subscriptions, `list_changed` notifications | MCPClient.swift:96, :526 | — (60 s catalog cache instead) | dropped: needs long-lived sessions, which serverless doesn't keep |
| Progress notifications → activity lines | MCPClient.swift:507 | tools.ts `onprogress` → `tool.progress` | done (WP-A7) |
| Elicitation: form and URL | MCPTypes.swift `MCPElicitation` | client.ts → runner `elicit` (park/resume) | done |
| Per-tool disable, per-chat off-switch, trust in plan mode | AgentRuntime.swift:310 | tools.ts `checkExecution`, execution.ts trusted sources | done |
| Per-host AI-data consent | app ConnectorPrompts | shared.ts `requireConsent` | done |
| Connector health status + unavailable turn notes | AgentRuntime unavailable reasons | features/mcp/health.ts | done (WP-A6) |
| MCP server registry search/install | MCPRegistryClient.swift, MCPInstaller.swift | features/mcp/registry.ts `/connectors/registry` → existing health-checked create | done (WP-A8) |
| **Providers** | | | |
| Anthropic Messages, OpenAI Chat, OpenAI Responses (streaming) | AgentProviders/Anthropic, OpenAI | packages/agent/src/providers.ts, streams.ts, wire.ts | done |
| Capability flags gate features (never provider names) | ModelProvider capabilities | wire.ts, execution.ts `resolveProvider` | done |
| Learned rejections (no tools/images, effort levels) persist 14 days | Services/ProviderSettings.swift | execution.ts `recordLearning`/`learnedFor` | done (WP-A7) |
| Per-model reasoning efforts + clamping | Provider/EffortLevels.swift | wire.ts `clampEffort`, Model.reasoningEfforts | done |
| Model list: server-side search, pagination, pins, favorites | ProviderSettings (pins) | app.ts `/v1/models`, `/v1/models/preferences` | done |
| Server web search tool when supported | wire builders | wire.ts `webSearch` + `serverWebSearch` | done |
| Provider probe (check tool calling and vision actually work) | AgentProviders/ProviderProbe.swift | provider-probe.ts `/providers/:id/test` with modelId; persists learned rejections | done (WP-A8) |
| **Loop** | | | |
| Modes ask/plan/build/auto, policy matrix | AgentCore Engine, policy | packages/agent/src/policy.ts | done |
| Frozen system prompt + mode/effort turn notes | SystemPrompt.swift, TurnNotes.swift | conversation.ts | done |
| Nested approvals, "always allow" (argument-bound) | AgentCore Engine | runner.ts, policy.ts | done |
| Elicitation park/resume | AgentCore Engine | runner.ts | done |
| Compaction (provider summary, fingerprinted transform) | AgentCore Transcript | runner.ts `compact` | done |
| Cancel (stream, tool, parked), retries with backoff | AgentCore Engine | runner.ts, service.cancel | done |
| Edit/retry a turn (truncate from a turn) | ChatStore | `/v1/chats/:id/truncate` | done |
| Chat titles from the first message / attachments | App/ConversationTitle.swift | apps/api/src/attachments.ts `makeTitle` | done (WP-A7) |
| Usage accounting (per run, streamed) | Provider usage | runner usage → `usage` events, snapshot | done |
| Background runs survive the app | BACKGROUND_PLAN, Live Activity | durable server runs + QStash continuation | done (replaced) |
| **Other** | | | |
| Attachments to the model: images, PDFs ≤ 10 MB, text ≤ 200 KB, others via `fs` | Agent/AttachmentMedia.swift | attachments.ts, tools/media.ts (rehydrated at request time, images re-encoded > 3.5 MB / 2000 px) | done (WP-A7) |
| Uploads (direct to storage, ≤ 25 MB) | AttachmentStore | features/tools + convex/files.ts, uploads.ts | done |
| Voice transcription (Groq) | VOICE_PLAN | features/tools/transcribe.ts | done |
| Skill scripts (Python/shell in skills) | — (already dropped in the app) | — | dropped |
| stdio / local-process MCP servers | MCPServerConfig | — (remote HTTP only) | dropped |

**Counts:** done 45 (7 filled in WP-A7, 4 in WP-A8) · partial 0 · missing 0 · dropped 3.

## WP-A8 additions
- Registry installs retain entry ID and verified digest; `GET /v1/skills/updates` compares cached listings (10 minutes). `POST /v1/skills/:id/update` checks the digest again and preserves skill identity and enabled state.
- `POST /v1/skills/import` accepts `skill.import` + owned attachment ID. ZIP, tar and tar.gz are validated in memory: 25 MB archive, 5 MB expanded, 100 entries, 500 KB text files, path/type/collision checks and compression ratio cap 100. One root skill or one wrapper folder; scripts and binaries are dropped and reported.
- `GET /v1/connectors/registry?q=&cursor=` proxies the same official `/v0.1/servers` registry used by Swift, through guarded egress with a 10 minute cache. Only remote HTTP/SSE candidates are returned; clients add `input` via the existing health-checked `POST /v1/connectors` route. Templates/header names indicate required configuration.
- `POST /v1/providers/:id/test` retains model-list-only behavior without modelId. With modelId and host consent it explicitly probes streaming, tool calling, claimed vision, and advertised reasoning efforts. Classified rejections seed the existing 14-day learned store; successful probes clear old rejections. No-tool answers remain uncertain and do not seed a rejection.

## Remaining
None in this audit's scope.
