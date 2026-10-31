# Web / iOS parity evidence — WP-B3

Captured 2026-10-31 from the real local API on 8817 and Vite on 5191. Each account
starts empty; tool and approval examples use the API's explicit local scripted driver.
These are behavior and visual comparisons, not a claim of pixel-perfect parity.

## References and limitations

`~/.praxis-agent-state/cloud/reports/ios-screens/` was unavailable at capture time.
The iOS links below are the existing **light** simulator captures. Their files named
`dark-*` are actually light and are deliberately not used. Web dark mode is captured,
but **native dark visual parity remains unverified** until WP-C3 supplies real dark images.
Related-reference rows explicitly identify screens lacking an exact native capture.
Desktop uses the same mobile iOS reference; there is no native desktop target.

Color source: [Tokens.swift](../../../PraxisChat/PraxisChat/DesignSystem/Tokens.swift).
All 13 light/dark color pairs match the web tokens; a unit test checks them. Primary
actions follow [Buttons.swift](../../../PraxisChat/PraxisChat/DesignSystem/Buttons.swift):
ink fill and canvas foreground, including dark-mode inversion. The old sage-accent
claim was incorrect. Surface/secondary/tertiary/danger/rule aliases resolve to native
card/fill/secondaryInk/mutedInk/destructive/hairline; the warning alias is neutral
secondaryInk because the native token source defines no warning color.

## Screen matrix

| Screen | iOS light reference | Web 402×874 light | Web 402×874 dark | Web 1440×900 light | Match / mismatch |
|---|---|---|---|---|---|
| New chat and composer | [iOS](reference/ios/light-chat-0-bottom.png) | [Light](reference/web/b3-mobile-light-chat-empty.png) | [Dark](reference/web/b3-mobile-dark-chat-empty.png) | [Desktop](reference/web/b3-desktop-light-chat-empty.png) | Matches the round history/compose controls, centered title/model, ink-filled plus, camera, mic, and placeholder. System theme follows OS until explicitly set. Browser safe areas/fonts differ; web starter suggestions are additional. |
| Plus tray | [iOS](reference/ios/light-tray-2-main.png) | [Light](reference/web/b3-mobile-light-plus-tray.png) | [Dark](reference/web/b3-mobile-dark-plus-tray.png) | [Desktop](reference/web/b3-desktop-light-plus-tray.png) | Matches mode/model/effort/media order, tagline and chevron, four tiles, effort copy, photo access and Web search. Browser photo selection grants only selected files; Screenshot opens saved-image selection. Unsupported hosted search is disabled. |
| Finished activity | [iOS](reference/ios/light-activity-finished-folded.png) | [Light](reference/web/b3-mobile-light-chat-tools.png) | [Dark](reference/web/b3-mobile-dark-chat-tools.png) | [Desktop](reference/web/b3-desktop-light-chat-tools.png) | Uses server run timestamps for Worked for Ns. Local scripted runs finish in under a second and display 0s. Native example has different elapsed time/content. |
| Activity details | [iOS](reference/ios/light-activity-finished-list.png) | [Light](reference/web/b3-mobile-light-activity-expanded.png) | [Dark](reference/web/b3-mobile-dark-activity-expanded.png) | [Desktop](reference/web/b3-desktop-light-activity-expanded.png) | Uses server presentation titles and SVG status icons. Tool payloads remain server-provided; web reasoning/details still use bordered disclosures rather than exact native row treatment. |
| Approval | [iOS](reference/ios/light-activity-tool-detail.png) | [Light](reference/web/b3-mobile-light-approval.png) | [Dark](reference/web/b3-mobile-dark-approval.png) | [Desktop](reference/web/b3-desktop-light-approval.png) | Ink-filled primary action is visible in both themes. Related iOS tool-detail image only: no native approval-card capture is available, so exact card parity is unverified. |
| Chats/history | [iOS](reference/ios/light-history-0-top.png) | [Light](reference/web/b3-mobile-light-history.png) | [Dark](reference/web/b3-mobile-dark-history.png) | [Desktop](reference/web/b3-desktop-light-history.png) | Chats title, search, date groups, previews without markdown punctuation, and menus replace All/Pinned chips. Touch row actions remain explicit buttons; native uses contextual gestures. |
| Settings | [iOS](reference/ios/light-settings-0-root.png) | [Light](reference/web/b3-mobile-light-settings.png) | [Dark](reference/web/b3-mobile-dark-settings.png) | [Desktop](reference/web/b3-desktop-light-settings.png) | Model providers and AI data sharing use native section names and explanatory copy. Web retains Appearance; the development lab is excluded from production settings. |
| Provider editor | [iOS](reference/ios/light-settings-7-editor-top.png) | [Light](reference/web/b3-mobile-light-provider.png) | [Dark](reference/web/b3-mobile-dark-provider.png) | [Desktop](reference/web/b3-desktop-light-provider.png) | Preset picker, /v1 Anthropic URL, Model copy, header Save and Test connection are present. Test connection saves the endpoint first and surfaces server errors. |
| Provider capabilities | [iOS](reference/ios/light-settings-8-editor-scrolled.png) | [Light](reference/web/b3-mobile-light-provider-capabilities.png) | [Dark](reference/web/b3-mobile-dark-provider-capabilities.png) | [Desktop](reference/web/b3-desktop-light-provider-capabilities.png) | Capability switches persist via the API. The native source has 10 switches; web exposes all 12 protocol flags, adding server compaction and tool search. |
| Connectors | [iOS](reference/ios/light-settings-2-connectors.png) | [Light](reference/web/b3-mobile-light-connectors.png) | [Dark](reference/web/b3-mobile-dark-connectors.png) | [Desktop](reference/web/b3-desktop-light-connectors.png) | Navigation and Add by URL are present; web captures a real empty account, while native reference has configured connectors. |
| Add connector | [iOS](reference/ios/light-settings-3-add-url.png) | [Light](reference/web/b3-mobile-light-connector-add.png) | [Dark](reference/web/b3-mobile-dark-connector-add.png) | [Desktop](reference/web/b3-desktop-light-connector-add.png) | URL/name entry and explicit connection errors; no invented connected state. Native and web field spacing/material rendering differ. |
| Skills | [iOS](reference/ios/light-settings-5-skills.png) | [Light](reference/web/b3-mobile-light-skills.png) | [Dark](reference/web/b3-mobile-dark-skills.png) | [Desktop](reference/web/b3-desktop-light-skills.png) | Import/browse controls and real empty state. Native reference has seeded skills; no reference data is injected into web. |
| Image reader | [iOS](reference/ios/light-settings-6-image-reader.png) | [Light](reference/web/b3-mobile-light-image-reader.png) | [Dark](reference/web/b3-mobile-dark-image-reader.png) | [Desktop](reference/web/b3-desktop-light-image-reader.png) | Vision capability gating and model selection use real models; configured model content differs from native demo. |
| Voice input | [iOS](reference/ios/light-settings-0-root.png) | [Light](reference/web/b3-mobile-light-voice.png) | [Dark](reference/web/b3-mobile-dark-voice.png) | [Desktop](reference/web/b3-desktop-light-voice.png) | Related settings-root reference only: no direct native voice-screen capture available. Configuration and transcription errors are real; exact layout parity remains unverified. |
| AI data sharing | [iOS](reference/ios/light-consent-0-sheet.png) | [Light](reference/web/b3-mobile-light-sharing.png) | [Dark](reference/web/b3-mobile-dark-sharing.png) | [Desktop](reference/web/b3-desktop-light-sharing.png) | Related native consent-sheet reference only: web shows the consent-management list. Per-host revocation remains available; exact list parity lacks a native capture. |

## Desktop and navigation checks

- At ≥1024 px, Chats stays visible in a 280 px sidebar and selecting a row changes `/c/:chatId`.
- Chat text is constrained to 402 px and the composer/header to 442 px, centered in the remaining workspace.
- Sheets become centered 640 px glass dialogs; mobile sheets remain bottom sheets.
- Desktop Enter sends, Shift+Enter inserts a newline, and touch Return inserts a newline. IME composition does not submit.
- ⌘K / Ctrl+K opens Chats search; Escape dismisses the current sheet or tray.
- `/`, `/c/:chatId`, `/chats`, `/settings`, and settings sub-pages restore from URLs; back/forward are checked.
- Model search is debounced 250 ms against `/v1/models?q=&cursor=&limit=50`, includes pagination, and discards stale responses.

## Reproduce

From the repository root with the API/web on the assigned ports:

```
~/.praxis-agent-state/cloud/tools/slot.sh WP-B3 node cloud/apps/web/scripts/b3-check.mjs
~/.praxis-agent-state/cloud/tools/slot.sh WP-B3 node cloud/apps/web/scripts/parity-capture.mjs
node cloud/apps/web/scripts/parity-links.mjs
```

The capture script writes 45 screenshots (15 views × 3 variants). Chromium is the
verified browser here. WebKit/Firefox refraction remains WP-B4; dropdown internals
remain WP-B2's merged implementation.
