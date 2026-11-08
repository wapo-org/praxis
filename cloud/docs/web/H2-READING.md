# H2: response reading, work history and following

The comparison is available in development at `/lab/activity`. The capture script writes `typography-options-light.png`, `typography-options-dark.png`, `typography-metrics.json` and the two `work-log-source-comparison` images to the H2 artifact directory.

## Reading choice

The three candidates use existing type tokens: compact Inter 14/20, reading Inter 16/26, and editorial Source Serif 19/32. **Reading Inter 16/26 is selected.** It remains legible through a long technical answer without the density of the compact option or the extra scanning height of the editorial option. The 70ch maximum measure fits inside the 720px column. Strong body ink distinguishes the response from the smaller, muted UI. Paragraph/list spacing, a four-level heading scale, mono code, quieter blockquotes and tabular figures are part of the treatment, rather than changing only the body size. The app's main-area HTML font and global colour tokens are unchanged.

## T3 source port

Read-only MIT sources: `/tmp/praxis-run/t3code-src/t3code/apps/web/src/components/chat/{WorkLog,TimelineWorkGroupRows,TimelineWorkEntryRow,TimelineToolActivityIcon,MessagesTimeline}` and their logic files. Copyright and the full MIT notice are preserved at the top of adapted files.

The comparison's left pane is a **source reproduction**, not a screenshot of the T3 app. It reproduces WorkLogLine and TurnFoldTimelineRow's class geometry with explicit CSS: 24px icon slot and minimum row height, 6px baseline gap, 14px relaxed labels, 28px details indent, mono previews/pre bodies, muted labels and a trailing disclosure. The right pane renders the actual Praxis components. Tool kinds and failures use the same Lucide family as T3. Questions retain their heading and answer preview, with full input/output available on expansion. “Details” and success checkmarks no longer replace a tool-type icon.

## Scroll state

`useStreamAnchor` owns both following and Jump to latest. It measures overflow and distance on scroll, viewport/content resize and chat identity changes. A height-growth scroll event is not evidence of user intent to leave the bottom. Upward movement or wheel/touch/key interaction can stop following; a jump resumes it. The fixed overlay fades without affecting the column and becomes inert when hidden. Browser regressions cover short chats, up/down, streamed growth while reading above, clicking, chat changes and a resize that makes the conversation fit.
