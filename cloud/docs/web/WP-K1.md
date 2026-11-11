# WP-K1 implementation and evidence

## Tool exposure

Production modules select connector tools per run using account-wide tool activity snapshots (including nested calls), message history fallback, eight hybrid semantic matches through the same embedder as chat search, and tools already used in the conversation. Small catalogues (18 tools or fewer) stay directly exposed. Larger catalogues retain hidden definitions and the catalogue gateway as a long-tail fallback. Built-ins, including ask_user, stay available. A new run refreshes the exposure snapshot; a parked run keeps its execution contract.

Curated connector briefs live in tool-briefs.ts. Generic MCP descriptions are compressed without changing their schemas. Original MCP names survive qualification so activity display titles never need to show hashes. Tool schemas can exceed the approximately 1,500-token target for large unions; the usage briefs and measured sample fit, but a strict universal schema-inclusive cap is not implemented because it would conflict with exposing the full frequency/sticky union. Review the measured sample rather than treating it as a worst-case bound.

## Sensitive answers

HTTP form responses are protected before decisions are stored or execution resumes. Password/x-sensitive fields become opaque references; AES-256-GCM ciphertext is owner-bound. Only metadata participates in sync. Values are reconstructed at the execution boundary for env/headers and are redacted from outputs, object keys, nested calls, progress and errors. QuickJS KV persistence is also redacted. Saved entries can be reused by field name, renamed and deleted. Production persistence uses the existing account store and encryption keyring; local in-memory restarts intentionally erase account data.

Tests inspect storage revision history, events, checkpoints, transcripts and recorded fake-provider requests. QuickJS tests deliberately echo and persist the synthetic credential in both keys and values.

## Titles

Chrome's Prompt API runs only when availability() is "available"; no automatic model download is requested. A bounded session is destroyed after use. Otherwise the server requests one non-streaming completion with 20 output tokens from the account's provider. Advertised token pricing selects the cheapest model; without prices, speed metadata and lightweight family names guide selection. Provider failures fall back to deterministic meaningful words. User renames are preserved.

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
