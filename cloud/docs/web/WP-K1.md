# WP-K1 implementation and evidence

## Tool exposure

Production modules select connector tools per run using account-wide tool activity snapshots (including nested calls), message history fallback, eight hybrid semantic matches through the same embedder as chat search, and tools already used in the conversation. Small catalogues (18 tools or fewer) stay directly exposed. Larger catalogues retain hidden definitions and the catalogue gateway as a long-tail fallback. Built-ins, including ask_user, stay available. A new run refreshes the exposure snapshot; a parked run keeps its execution contract.

Curated connector briefs live in tool-briefs.ts. Generic MCP descriptions are compressed without changing their schemas. Original MCP names survive qualification so activity display titles never need to show hashes. Tool schemas can exceed the approximately 1,500-token target for large unions; the usage briefs and measured sample fit, but a strict universal schema-inclusive cap is not implemented because it would conflict with exposing the full frequency/sticky union. Review the measured sample rather than treating it as a worst-case bound.

## Sensitive answers

HTTP form responses are protected before decisions are stored or execution resumes. Password/x-sensitive fields become opaque references; AES-256-GCM ciphertext is owner-bound. Only metadata participates in sync. Values are reconstructed at the execution boundary for env/headers and are redacted from outputs, object keys, nested calls, progress and errors. QuickJS KV persistence is also redacted. Saved entries can be reused by field name, renamed and deleted. Production persistence uses the existing account store and encryption keyring; local in-memory restarts intentionally erase account data.

Tests inspect storage revision history, events, checkpoints, transcripts and recorded fake-provider requests. QuickJS tests deliberately echo and persist the synthetic credential in both keys and values.

## Titles

Chrome's Prompt API runs only when availability() is "available"; no automatic model download is requested. A bounded session is destroyed after use. Otherwise the server enqueues the run immediately with a keyword title and generates a title in background work registered with the existing Vercel waitUntil hook. It tries at most two eligible paid text models, preferring small instruct families before price. Free/zero-priced, mandatory reasoning and non-text models are excluded. Each completion has 32 output tokens and an eight-second deadline. OpenRouter requests use metadata-compatible none/minimal/low reasoning plus exclude; exclude alone does not reduce reasoning token usage. Safe failure codes and per-attempt usage are stored in titleMetric. Compare-and-set updates preserve settings and manual rename intent, including a rename to the existing title. PATCH defaults no longer reset an omitted title. Keyword fallback strips request verbs and stop words.

Sources:
- https://developer.chrome.com/docs/ai/prompt-api — Gemini Nano, availability states and session lifecycle.
- https://developer.chrome.com/docs/ai/get-started — download and activation requirements.
- https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties — model pricing fields.

## Run 404

The client formerly replaced every 404 message with "Not available: <request path>", discarding the server's resource-specific explanation. After an in-memory restart, the first lookup in POST /v1/runs is the chat; a retained client chat id produces chat_missing. A missing provider is a separate case with an actionable provider_missing response. The selected provider/model is checked against refreshed account models. Both failed starts and streamed failures use plain recovery copy. A browser fixture verifies that a failed question submission keeps its answer and offers retry in both engines.

## Menu causes

- Cascade panels were keyed by active submenu path: opening a child remounted the parent's rows and restarted their arrival animation.
- That restarted animation and delayed live backdrop handed the child a clear initial surface; the child now has a native backdrop from creation.
- Chromium's displaced lens on small pill triggers produced rim echoes; these triggers now use one clipped native frost layer.
- The outer shell previously became a rectangular scrolling compositor, clipping the glass and last item; scrolling now stays in the inner viewport, capped after fixed rows are measured.
- Cascade positioning previously had no viewport calculation. Children now flip, shift and cap their inner scroll lane; a 402×450 live-browser test covers the last item.
- Negative action-grid margins put square tile highlights against the rim; the inset grid now uses equally rounded squircle tiles.

The installed headless WebKit does not paint backdrop blur even on a standalone HTML control. Its layout/focus/mounting results are valid; optical blur onset is not verified there. See webkit-native-blur-control.png in the capture directory.

Evidence is in ~/.praxis-agent-state/cloud/design/K/K1/ (synthetic data only). No new dependencies.

## Owner's follow-up: compact questions and saved values

The question title now stays outside a compact, borderless gray form surface. Pill inputs use their own contrasting surface and hairline. The shared approval surface uses the same fill and spacing.

Secrets & variables has its own Settings route (/settings/saved-values), with manual secret, text and JSON creation, rename and delete. Secret values remain write-only. Submit and save persists ordinary question answers as variables and sensitive answers as encrypted references; matching saved variables can be reused in later forms.

A missing saved-values endpoint is treated as a server capability mismatch, with Retry and no contradictory empty-account message. Sensitive question submission is blocked until the server confirms support; failed capability checks cannot send a credential to an old API. Existing saved-secret endpoints remain supported. A fresh API returns 200 for an empty list. Owner-held server ports are not restarted by this worker.

## WP-K1d fake OpenRouter evidence

A real HTTP fixture reproduces the former price-sort hazard (a free-model 429), empty reasoning-only output, and a queue response after the old three-second deadline. The replacement skips ineligible models, records rate_limited / empty / timeout / provider_error: HTTP status without provider payloads, retries one other eligible model, and accepts a delayed response under eight seconds. The actual eight-second abort is tested. A gated title promise proves the run finishes while title work remains pending, and defer receives both tasks. No owner-provider cause is asserted without a live credential; these are confirmed reproductions of the code paths.

OpenRouter budget and per-model reasoning metadata reference: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens . Reasoning consumes the output budget; exclude hides reasoning and does not disable it. The title request chooses an accepted low/no-reasoning effort from model metadata.
