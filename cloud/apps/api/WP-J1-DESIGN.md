# Connector execution and consent

Execute (`build` on the wire) executes every tool without approval, including skill saving and destructive or untrusted MCP tools. Tool input validation, disabled-tool checks, authorization and data consent remain enforced. Auto permits non-destructive trusted tools and asks for destructive/untrusted writes. Ask refuses external-service tools, code execution and skill changes; existing built-in read helpers remain available. Plan remains trusted read-only.

Installing a custom connector or enabling a connector records consent for its exact host (including non-default port). Disabled preinstalled connectors do not imply consent. Data consents can withdraw it. The next tool call then elicits `Allow <host>` inline and resumes from the durable checkpoint after acceptance. JavaScript fetch goes through this same path before guarded public egress. It previously failed at `publicFetch(..., consent=true)` with an exception serialized as a JavaScript error, rather than parking for consent. The screenshot alone cannot establish whether that particular call also encountered another network error.

MCP resources remain accessible through the explicit Settings API; resource list/read wrappers are no longer model tools. Resource listing was an irrelevant fallback for a web search and also hit the separate MCP consent requirement. The actual Exa search tool is now advertised with its purpose.

## Built-in sources and defaults

All four connectors are installed server-side disabled, once per account, with removal tombstones respected. MCP tool definitions are discovered from the service, not invented; offline Settings shows a starter catalog until connected. Unknown tools discovered later remain enabled except the configured defaults below.

- Exa: https://mcp.exa.ai/mcp ; keyless search/fetch/advanced search, optional encrypted key sent as `x-api-key`. Only `web_search_exa` enabled by default; other known tools off. The keyless tools query excludes agent_run: including it makes the handshake fail with authentication required (verified live). The transport adds it only when an encrypted key is present. Source: https://exa.ai/docs/get-started/exa-mcp
- Firecrawl: https://mcp.firecrawl.dev/v2/mcp ; keyless search/scrape/parse, optional encrypted Bearer key for full service. All discovered tools except `firecrawl_search` enabled. OAuth uses https://mcp.firecrawl.dev/v2/mcp-oauth (account sign-in required). Sources: https://docs.firecrawl.dev/mcp-server and https://docs.firecrawl.dev/mcp-server/keyless
- E2B: official `@e2b/code-interpreter` SDK against https://api.e2b.dev ; encrypted API key required. `run_code` enabled; each call creates a sandbox bounded to 60 seconds, runs Python or JavaScript, and destroys it in finally. No stdio subprocess. Source: https://docs.e2b.dev/quickstart
- Browserbase: https://mcp.browserbase.com/mcp ; encrypted API key required, injected only into the transport query (`browserbaseApiKey`), never stored in the public URL. All discovered tools enabled, including start/end/navigate/observe/act/extract. Must pass sessionId across calls because the transport is reconnected. Source: https://docs.browserbase.com/integrations/mcp/setup

Firecrawl features researched: scrape with JSON replaces deprecated Extract; map finds URLs; crawl traverses and status resumes; parse handles documents (hosted file uploads need two-call handoff); agent/status handles asynchronous research; interact/stop handles browser sessions; scientific research, developer and government indexes find specialized sources; monitor tools schedule recurring checks; feedback tools are optional. Limits depend on plan, use small limits and poll job IDs. Source: https://docs.firecrawl.dev/mcp-server/tools

Alexandria is Firecrawl's catalogue of typed third-party data tools, not a crawler mode or vector database. Discover contracts with `firecrawl_find_tools`, execute through scrape's `alexandria` argument, at most ten calls in a batch. Authenticated sessions only; discovery free, executions priced per tool; an org admin must accept required third-party terms. Sources: https://docs.firecrawl.dev/features/alexandria and https://docs.firecrawl.dev/mcp-server/tools

## Provider tests and model catalogs

Discovery metadata fills all capability switches even when a later live probe fails; successful probe observations then replace tools/vision/reasoning detection. The user can override switches before saving. Provider error messages remain visible with credentials redacted. Real OpenRouter reproduction is pending the owner's key; no claim is made that the exact reported failure has been reproduced.

The model refresh endpoint sliced the list to 100 and then returned no continuation cursor. Bootstrap also sliced to 50. Both now return the complete catalog. Existing model picker search and virtualization remain in place.
