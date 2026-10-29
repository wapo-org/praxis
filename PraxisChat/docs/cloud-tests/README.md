# Deterministic cloud acceptance harness

`Cloud/Testing/CloudTestBackend.swift` is DEBUG-only. It is a protocol-v0 server
implemented through a session-scoped URLProtocol. It intercepts every request
in its injected session; an unknown route returns a typed 404 locally. No
external server, account, provider key, npm dependency or package change is
required. Each test backend has independent chats, runs, tokens and request log.

## Launch and integration hook

Launch without `-PraxisEngine` to exercise the cloud default:

```
-PraxisResetData YES
-PraxisMockGallery YES
-PraxisCloudStub YES
-PraxisCloudScenario text
-PraxisCloudServerURL https://cloud.praxis.test
```

`CloudTestBackend.makeLaunchSessionIfEnabled() -> URLSession?` returns nil unless
`PraxisCloudStub` is true. When enabled, all cloud API, SSE and settings clients
must share this session. The singleton launch backend shares account/run state
across those clients. Unit tests construct `CloudTestBackend(scenario:)` and call
`makeSession()`. Teardown calls `session.invalidateAndCancel()` and
`backend.shutdown()` to release connections and the registry entry.

The session supplies a `Bearer dev-local` default, matching A's documented local
token. Seed the injected client's token store with `CloudTestBackend.token` for
its configured origin before a stale simulator Keychain token can override it.
`GET /v1/auth/session` works without a token in this test backend; sign-in,
sign-up and auth/dev return `bearerToken: dev-local`. Session queries omit it.
Sign-out revokes access, and a later sign-in restores access. This is a fixture,
not a security implementation or a test of the production authentication server.

The account test navigates History → History options → Settings → Account &
server (`cloudAccountServer`). It uses the settings agent's identifiers
`cloudServerURL`, `cloudAccountStatus`, `cloudEmail`, `cloudPassword`,
`cloudSignIn`, and `cloudSignOut`.

## Scripts and transport behavior

`PraxisCloudScenario` supports `text`, `tools`, `approval`, `nestedApproval`,
`elicitation`, `compaction`, `vision`, `cancel`, `reconnect`, and `error`.
A `run.start.script` field can override the session's script, using A's v0 script
names (`nestedApproval`, not an invented alias). `cancel` and `reconnect` are
harness-only selectors and are not asserted to exist on the real API.

The fixtures use A's schemas in `cloud/packages/protocol/src/index.ts` and routes
in `PROTOCOL.md`: resource discriminators, UTC timestamp strings, page wrappers,
run descriptors and run.event envelopes with positive per-run numeric IDs.
Approval and elicitation requests park until their POST; cancel creates a
terminal event. Disconnected clients leave the server run untouched. A replay
uses `Last-Event-ID` (header wins over `after`), strictly after the accepted ID.
An invalid/future cursor returns 409 `cursor_expired`. Completed replay includes
the terminal event and closes. Unknown routes never fall back to the network.

SSE frames use CRLF, comments and retry fields. Delivery splits frames into
three callbacks, including inside UTF-8 when present. Frames retain order during
an approval/cancel race with replay. `reconnect` drops the first connection after
the first text delta (event 4); a second connection must resume and finish the
answer once. The harness records HTTP methods, paths, bodies and resume headers
without logging credentials.

## Test ownership and legacy launches

`CloudTestBackendTests` checks server contracts and races. C-net owns production
client/parser/auth/engine tests. `CloudUITests` drives default cloud, settings,
account, send, allow/deny, nested approval, elicitation, cancel, compaction,
vision, and reconnect through actual UI controls and production HTTP/SSE code.
Screenshots are retained as XCTest attachments.

Existing demo-dependent UI suites now use explicit `-PraxisEngine demo`,
including relaunches and optional screenshot probes. Scripted background tests
retain their explicit scripted engine. Native provider-consent coverage opts
into the sunset loop with `-PraxisNativeLoopEnabled YES -PraxisEngine live`.
No existing test is blanket-skipped and no native package file is modified.
Existing opt-in screenshot/performance skips keep their original reasons.

## Running on the shared machine

Create a private simulator and use its UUID; disable parallel testing to avoid
Xcode creating multiple extra simulators. Every xcodebuild goes through a slot:

```sh
~/.praxis-agent-state/cloud/tools/slot.sh C-tests xcodebuild \
  -project PraxisChat/PraxisChat.xcodeproj -scheme PraxisChat \
  -destination 'platform=iOS Simulator,id=<C-tests UUID>' \
  -parallel-testing-enabled NO \
  -derivedDataPath /tmp/praxis-cloud-dd/C-tests \
  -resultBundlePath /tmp/praxis-cloud-dd/C-tests-harness.xcresult \
  -only-testing:PraxisChatTests/CloudTestBackendTests test
```

Use `-only-testing:PraxisChatUITests/CloudUITests` for cloud acceptance. Run the
existing `PraxisChatUITests` target after merging C-net, C-screens and Lead C's
construction hooks. Exact results and artifact paths are in `RESULTS.md` once
run. Lead C owns integration and the final frozen package suite.
