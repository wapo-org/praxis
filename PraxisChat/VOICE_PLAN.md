# Voice input via Groq — design (Wave 2, item 5)

Owner: `voice` (orchestrator). Workers: `voice-rec` (recorder + composer UI),
`voice-groq` (Groq client + settings + queue). This plan is the contract
between them: the file layout and the Swift interfaces below are FROZEN unless
both workers and the orchestrator agree to change them.

Guiding rule (the user's words): "very well thought through with all the
quirks, so user does not accidentally lose long recording". Every decision
below prefers keeping audio over convenience: recording writes straight to
disk, every failure keeps the file and offers Retry, and deletion needs an
explicit user act or a sent message.

## 1. Groq speech-to-text research (2026-10-28)

Sources:

- Endpoints, models, limits, params, formats:
  `https://console.groq.com/docs/speech-to-text`
- Model list endpoint: `https://console.groq.com/docs/models`
- Chunking tutorial:
  `https://github.com/groq/groq-api-cookbook/tree/main/tutorials/audio-chunking`

Facts used by this design (all from the STT docs page unless noted):

- Transcribe: `POST https://api.groq.com/openai/v1/audio/transcriptions`,
  OpenAI-compatible multipart (`file`, `model`, plus optionals). Translate
  (any language → English):
  `POST https://api.groq.com/openai/v1/audio/translations`. We use
  transcriptions only.
- Speech models: `whisper-large-v3-turbo` (transcription only, fastest and
  cheapest, $0.04/hr, ~12% WER) and `whisper-large-v3` (transcription and
  translation, $0.111/hr, ~10.3% WER). Both multilingual.
- Max file size: 25 MB (free tier), 100 MB (dev tier). Larger files must be
  chunked client-side (the cookbook tutorial) — there is a `url` parameter
  alternative, but we never host anything, so we chunk.
- Accepted formats: `flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`,
  `wav`, `webm`. We record `.m4a` (AAC), which is accepted directly.
- Optional params: `language` (ISO-639-1, improves accuracy/latency),
  `prompt` (≤ 224 tokens, style/continuity guidance, same language as the
  audio), `response_format` (`json` default, `verbose_json` for segment
  timestamps, `text`), `temperature` (default 0, recommended), and
  `timestamp_granularities[]` (`segment` and/or `word`, needs `verbose_json`).
- The server downsamples to 16 kHz mono before transcribing, so recording at
  16 kHz mono loses nothing.
- Model discovery: `GET https://api.groq.com/openai/v1/models` with
  `Authorization: Bearer <key>` returns an OpenAI-compatible
  `{ data: [{ id, object, created, owned_by, ... }] }` list (models doc). The
  list carries NO speech capability flag, so the app filters speech models by
  id: contains `whisper` (case-insensitive). Unknown future STT ids are still
  selectable via a "Use model id…" manual entry row (same fallback pattern as
  chat servers without a model list).
- Auth failures are 401 (`invalid_api_key`); rate limits are 429 with
  `retry-after`. The package's `HTTPResponseHead.retryAfter` already parses
  both seconds and HTTP-date forms, capped at 60 s.

## 2. Recording (voice-rec)

- Engine: `AVAudioRecorder` writing DIRECTLY to
  `Application Support/PraxisChat/Recordings/<uuid>.m4a`. Settings: AAC
  (`kAudioFormatMPEG4AAC`), 16 kHz, mono, ~32 kbps → ~14 MB/hour, so an hour
  fits even the free tier after segmentation, and typical recordings upload
  as one part. Meters on (`isMeteringEnabled`) for the level meter.
- Crash safety: the audio file is the truth (the recorder streams it to
  disk). A JSON sidecar `<uuid>.json` (state, conversation id, created date,
  duration, last segment table) is rewritten on every state change and every
  ~5 s while recording, atomically. A crash/kill/low-memory event can lose at
  most seconds of sidecar metadata, never audio. On launch, `RecordingStore`
  scans the folder: any sidecar not `.transcribed`/`.deleted`, plus any
  orphan `.m4a` without a sidecar, becomes a recoverable recording.
- Session: `AVAudioSession` category `.playAndRecord`, mode `.spokenAudio`,
  activated only while recording or paused (deactivate on stop so playback
  and other audio behave). Request `.record` permission on first mic tap;
  denied → inline explanation + "Open Settings" button, never a dead mic icon.
- Interruptions (phone call, Siri, alarm, `audioSessionDidBeginInterruption`):
  pause the recorder, persist the sidecar immediately, show "Paused — tap to
  resume". NEVER discard. End of interruption does NOT auto-resume (the user
  may be mid-call); it offers resume.
- Route changes (AirPods connect/disconnect, `routeChangeNotification`):
  keep recording on the new input when there is one; when the input vanishes
  (old device unavailable, no new input), pause with "Microphone
  disconnected — tap to resume", keep the file.
- Background + screen lock: recording CONTINUES. This needs the `audio`
  value in `UIBackgroundModes`, which is legitimate for an active recording
  (App Review allows background audio for recording; it must not be abused
  for agent runs — bg's plan covers that side). voice-rec adds ONLY the
  `audio` value and `NSMicrophoneUsageDescription` to Info.plist, and
  coordinates the merge with `bg` (who owns the other background keys) and
  `tray` (Photos usage text) per WAVE2 §4. When the app backgrounds
  mid-recording, persist the sidecar in the background notification too.
- Level meter + elapsed time in the composer while recording. Elapsed uses
  the recorder's `currentTime` (pauses excluded), not wall clock.
- Maximum length: warn at 60 min ("Long recording — X min"), then every 15
  min. NO silent hard stop: there is no auto-stop at all. Upload limits are
  handled by segmentation (§5), not by cutting the user off. Disk-full while
  recording → stop, keep the file, say so.
- Switching chats / back navigation mid-recording: the recording is bound to
  the conversation it started in (sidecar `conversationID`). Leaving the chat
  does NOT stop it; a compact recording pill (red dot + elapsed + tap to
  return) shows above the composer in any chat until it stops. Stopping
  always offers transcribe/review in the originating chat.
- App termination mid-recording: sidecar stays `.recording`; on next launch
  it is listed as an interrupted recording ("Interrupted 10:42, 12:34 —
  Transcribe / Delete"), fully recoverable.

## 3. UX (voice-rec owns, tray owns the mic button's LOOK)

- Tap mic → start recording (permission flow first when needed). While
  recording the composer middle shows: live level meter, elapsed time, and
  three actions: "Stop & transcribe" (primary), "Stop & review" (stops,
  keeps audio, shows play/delete/transcribe row), and cancel (X). Cancel of a
  recording longer than ~10 s needs "Discard this recording?" confirmation
  (destructive alert); shorter ones discard immediately.
- Pause/resume is a separate affordance from stop ("Paused — tap to resume"),
  used by interruptions and by an explicit pause button. Pause never
  transcribes, never deletes.
- Unfinished/failed recordings surface on next launch AND in a "Recordings"
  row (one row per recording: date, duration, state, Transcribe / Play /
  Delete). Entry point: a small banner above the composer when recoverable
  recordings exist ("Recording from 10:42 — Review"), plus the same list in
  Settings → Voice input. No recording is ever deleted without an explicit
  user delete or the sent-message rule below.
- Transcript insertion: appended to `store.draft` (with a separating space/
  newline when the draft is non-empty), NEVER replacing it. SwiftUI's
  `TextField` exposes no cursor, so insertion is at the end; the plan does
  not pretend otherwise. The user edits before sending.
- Audio deletion rule: the `.m4a` + sidecar are deleted only when (a) the
  user explicitly deletes the recording, or (b) its transcript was inserted
  AND a message containing that transcript was sent. Implementation: the
  controller remembers `(recordingID, insertedText)`; `ChatStore.send` calls
  `voiceController?.noteDidSend(text:)` after a successful send, and the
  controller deletes recordings whose inserted text is contained in the sent
  text. Transcribed-but-unsent recordings stay until the user deletes them.
- Mic button styling belongs to `tray` (solid black/white circle per item 10).
  voice-rec MUST NOT restyle it: keep the accessibility label exactly
  "Record voice message" and call tray's styled button. The recording-state
  UI (stop/cancel/review, meter, timer) is voice's, inside the composer
  middle area, monochrome liquid-glass per the README doctrine.

## 4. Groq settings, key, consent (voice-groq)

- Settings → "Voice input" section (new screen `VoiceSettingsScreen`, reached
  from SettingsSheet with a one-line surgical `navigationRow` addition; do
  NOT restructure SettingsSheet — picker/effort share it):
  - API key `SecureField` with show/hide toggle. Stored ONLY in the Keychain
    via the existing `SecretStore` (`KeychainSecretStore`), service
    `PraxisChat.Voice`, account `groq.apiKey`. Trimmed on save; empty removes.
    Never logged, never in `description`/`debugDescription`, never in
    crash/error strings.
  - Model picker: rows from the cached Groq model list filtered to STT ids,
    with refresh-on-open when stale (> 24 h, mirroring
    `ProviderSettings.modelListLifetime`) and a manual retry. Shows a
    sensible default: `whisper-large-v3-turbo` when listed, else the first
    listed STT model, else the manual-entry row. Persist the selected model
    id + cached list + fetch date in a NEW JSON file
    (`Application Support/PraxisChat/voice-settings.json`) owned by a NEW
    `GroqVoiceSettings` type — NOT in `ProviderSettings.swift` (effort/picker
    share that file; conflict map says prefer a new file).
  - Language row (Optional, "Auto" default; ISO-639-1 list of common
    languages) → the `language` param.
  - Recordings row → the recovery list (§3), shared with the composer banner.
- No key configured → tapping mic routes to Settings → Voice input with a
  short inline hint ("Add your Groq API key to use voice input"), not a dead
  end. Nothing is recorded before the key exists? NO — recording must not
  depend on the key: the user can record offline/before setup and transcribe
  later. Mic works without a key; TRANSCRIBE needs the key and routes to
  Settings when missing.
- Per-host AI-data consent: `api.groq.com` goes through the existing
  `AIDataConsent` before the FIRST upload. `Transcriber` throws
  `VoiceTranscriptionError.consentRequired(host:)` when not granted; the
  controller sets `ChatStore.pendingConsent` with a NEW
  `ConsentRequest.Action.transcribe(recordingID:)` case; allowing grants and
  retries the transcription, declining keeps the audio and the queued state.
  voice-groq adds the case + `ConsentSheet` copy ("Voice recordings" wording,
  what is sent: audio) + the `answerConsent` branch — all surgical additions,
  no restructuring of consent or store.

## 5. Transcription pipeline (voice-groq)

- Client: `GroqTranscriber: Transcriber` (§7), multipart POST to
  `/audio/transcriptions` with `file` (filename `<uuid>.m4a`), `model`
  (selected), `response_format=verbose_json`,
  `timestamp_granularities[]=segment`, optional `language`, and `prompt` for
  segment continuity. Temperature stays 0. Built ONLY on `any HTTPTransport`
  from AgentCore (injected; production uses `URLSessionTransport`, tests use
  `ScriptedTransport` from AgentTestSupport). No URLSession use directly, no
  singletons holding the key (the key is read per request from the settings).
- Segmentation: split recordings into ≤ ~10 min / ≤ 20 MB parts (20 MB stays
  under the 25 MB free-tier cap with multipart overhead headroom). Split
  points prefer silence: scan decoded PCM around each nominal boundary for a
  low-energy ~0.5 s window (pure function over samples, unit-tested with
  fixtures); fall back to the nominal boundary. Parts are exported with
  `AVAssetExportSession` (passthrough when possible) to temp files, each
  with a 5 s overlap into the previous part; the overlap's tail words are
  stripped at stitch time via verbose timestamps (drop words fully inside
  the overlap window). Transcribe parts SEQUENTIALLY in order, passing the
  previous part's tail text (≤ ~200 tokens) as `prompt`. Progress UI:
  "Transcribing 2/5" + per-part fraction.
- Stitching: concatenate part texts with single-space joining (no space
  before `.,!?;:%)]}`, no double spaces), offsetting `verbose_json` segment
  timestamps by part start for the record. Pure function, unit-tested.
- Errors (mapped by a pure `mapGroqError(status:data:)`):
  - 401 → "Check your Groq API key" + deep link to Settings → Voice input.
    Key is NOT cleared (it may be a paste away from correct).
  - 413 → re-split the failing part smaller (halve, min 1 min) and retry once
    per part; if it still fails, keep audio, offer Retry.
  - 429 → honour `retry-after` (via `HTTPResponseHead.retryAfter`), else
    exponential backoff (1 s, 2 s, 4 s … max 60 s), max ~5 attempts, then
    keep audio + Retry. Show "Rate limited — retrying in Ns".
  - offline (`URLError.notConnectedToInternet`, `networkUnreachable`, …) →
    state `.queued`, persist, and retry when `NWPathMonitor` reports usable
    network. Queue survives relaunch (sidecars in `.queued`).
  - 5xx / timeouts → same backoff as 429, then keep + Retry.
  - Every failure keeps the audio and the partial transcript (parts done so
    far), and offers "Retry" (resumes from the first untranscribed part) and
    "Delete". Cancellation (user) → back to `.stopped`, parts kept, no error.
- No Groq key exists in this environment and none may be requested; all
  network behaviour is verified with a scripted transport, and the final
  report states that a real-key, real-device check is still needed.

## 6. Code layout (FROZEN)

Everything new lives in `APP/Services/Voice/` (app target, synchronized
folder — NO pbxproj edits):

- `VoiceRecording.swift` (voice-rec): `VoiceRecording`, `VoiceRecordingState`.
- `RecordingStore.swift` (voice-rec): folder + sidecar CRUD, recovery scan.
- `VoiceRecorder.swift` (voice-rec): `AVAudioRecorder` wrapper (session,
  interruptions, routes, metering).
- `VoiceInputController.swift` (voice-rec): `@MainActor @Observable` UI state
  machine; owns recorder + store, calls `any Transcriber`.
- `VoiceRecordingViews.swift` (voice-rec): composer recording middle, review
  row, recovery banner/list rows.
- `GroqVoiceSettings.swift` (voice-groq): key (Keychain) + model list cache +
  selection + language. Persisted JSON separate from ProviderSettings.
- `GroqTranscriber.swift` (voice-groq): `Transcriber` protocol,
  `VoiceTranscript`, `VoiceTranscriptionError`, `GroqTranscriber`,
  `mapGroqError`.
- `AudioSegmenter.swift` (voice-groq): boundary scan, export, stitch.
- `TranscriptionQueue.swift` (voice-groq): retry/backoff/offline (`NWPathMonitor`).
- `VoiceSettingsScreen.swift` (voice-groq): Settings → Voice input screen.

Why the app, not `Packages/PraxisAgent/AgentProviders`: this is an app
feature (AVFoundation recording, Keychain `SecretStore`, SwiftUI settings,
consent sheet), not a chat provider for the agent loop. The Groq client stays
pure by depending only on AgentCore's `HTTPTransport` + AgentTestSupport's
`ScriptedTransport`, so it is unit-testable from `PraxisChatTests` without
touching the package. No new package module, no new dependencies.

Surgical edits to shared hotspot files (see conflict map; message before
big edits):

- `Components/Composer.swift` (voice-rec): replace placeholder
  `startRecording/stopRecording/isRecording` with calls into
  `VoiceInputController`; recording middle UI moves to `VoiceRecordingViews`.
  Do NOT touch the mic button's styling (tray's).
- `Screens/ChatScreen.swift` (voice-rec): recovery banner above the composer;
  `noteDidSend` hook after send.
- `Screens/SettingsSheet.swift` (voice-groq): one `navigationRow` to Voice
  input.
- `Services/AIDataConsent.swift` + `Screens/ConsentSheet.swift` (voice-groq):
  new `Action.transcribe` case + copy.
- `App/ChatStore.swift` (voice-groq, with voice-rec's hook): `answerConsent`
  branch for `.transcribe`; `send()` calls `noteDidSend`.
- `Info.plist` (voice-rec): `NSMicrophoneUsageDescription` + `audio` in
  `UIBackgroundModes`. Coordinate with `bg`/`tray` (§8).

## 7. FROZEN interfaces between the workers

```swift
// VoiceRecording.swift (voice-rec owns the file; both workers use it)
struct VoiceRecording: Codable, Identifiable, Sendable {
    var id: UUID
    var conversationID: UUID
    var state: VoiceRecordingState
    var createdAt: Date
    var duration: TimeInterval          // seconds of recorded audio
    var fileName: String                // "<uuid>.m4a" in the recordings folder
    var transcriptPreview: String?      // first ~120 chars once transcribed
}
enum VoiceRecordingState: String, Codable, Sendable {
    case recording, paused, stopped, queued, transcribing, transcribed, failed
}

// GroqTranscriber.swift (voice-groq owns the file; voice-rec consumes it)
struct VoiceTranscript: Sendable {
    var text: String
    var language: String?
    /// (absoluteStart, absoluteEnd, text) per verbose_json segment.
    var segments: [(start: TimeInterval, end: TimeInterval, text: String)]
}
enum VoiceTranscriptionError: Error, Sendable {
    case missingKey
    case consentRequired(host: String)
    case unauthorized            // 401: "Check your Groq API key"
    case tooLarge                // 413 after re-split: keep audio + Retry
    case rateLimited(retryAfter: TimeInterval?)
    case offline
    case server(message: String) // 5xx / decode failures, safe to show
    case cancelled
}
protocol Transcriber: Sendable {
    /// Transcribes `file` (a complete .m4a). Progress: (fraction, part, parts).
    /// Throws `VoiceTranscriptionError`. Never logs audio, keys, or transcripts.
    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript
}

// GroqVoiceSettings.swift (voice-groq owns; voice-rec reads isConfigured only)
@MainActor protocol VoiceSettingsReader {
    var isConfigured: Bool { get }   // key present (model may still default)
}

// VoiceInputController.swift (voice-rec owns; ChatStore calls noteDidSend)
@MainActor protocol VoiceSendObserver {
    func noteDidSend(text: String)
}
```

`VoiceInputController` is constructed with `(store: RecordingStore,
transcriber: any Transcriber, settings: any VoiceSettingsReader,
chatStore: ChatStore)` — concrete types in production, fakes in tests. The
transcriber runs segmentation + queue internally: one call, one transcript.

## 8. Coordination (orchestrator does this NOW, workers keep it up)

- `tray`: mic button look is tray's, behaviour is voice's. voice-rec must not
  restyle the button or rename its accessibility label. Tray's gallery work
  does not touch recording state.
- `bg`: Info.plist background modes. Voice adds ONLY the `audio` value (for
  active recording) + `NSMicrophoneUsageDescription`; bg owns the rest. Merge
  via WAVE2 §4 if both land near each other.
- `picker`/`effort`: SettingsSheet + ProviderSettings are shared. Voice adds
  one navigation row and a separate settings file/type — no edits to
  `ProviderSettings.swift` at all.
- `blur`: ChatScreen bottom edge + composer dock. voice-rec's banner must
  float in the ZStack like the composer dock (pitfall: `safeAreaBar`
  overflow is not hittable) and must not animate send's `scrollTo`.

## 9. Tests (both workers; reusable, in-repo)

- Unit (`PraxisChatTests`, Swift Testing): sidecar round-trip + recovery
  scan incl. orphan `.m4a` (voice-rec); silence-boundary scan, stitch
  joining/overlap strip, error mapping incl. 413-halving and retry-after
  parsing, model-list STT filter incl. manual-entry fallback (voice-groq).
- DEBUG seam `-PraxisFakeRecording <path>`: when present, tapping mic skips
  the recorder and finishes a recording from the bundled audio file at
  `<path>`, so UI tests run without a mic (voice-rec implements; both use).
  UI tests pass it plus a scripted-transport flag so no network happens.
- UI (`PraxisChatUITests`): record → stop → transcript appended to draft,
  draft preserved; cancel > 10 s asks; recovery banner → transcribe/delete;
  Settings voice screen: key field, model list loads (scripted), select
  persists; consent sheet for api.groq.com on first transcribe.
- No real Groq key exists here; never ask for one. E2E with a real key on a
  real device is explicitly out of scope and goes in the final report.
- Screenshots in light AND dark mode, actually looked at, for: recording
  composer, paused state, review row, recovery banner, Voice settings screen.

## 10. Integration order

voice-rec and voice-groq integrate to `hub/wave2/integration` independently
when done. `voice` (orchestrator) integrates LAST: merges both workers'
branches plus integration, runs the E2E check (scripted transport +
`-PraxisFakeRecording`), takes screenshots, then pushes.
