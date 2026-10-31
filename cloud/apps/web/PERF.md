# WP-B1 reproducible measurements (historical checkpoint)

Run API on 8817 and Vite on 5191, then from the checkout root:

```
BASE=http://127.0.0.1:5191 API=http://127.0.0.1:8817 ~/.praxis-agent-state/cloud/tools/slot.sh WP-B5 node cloud/apps/web/scripts/perf.mjs
```

The script uses Chromium, a 402×874 viewport, real local scripted tools and approval runs,
and a cookie-authenticated reload. It writes six screenshots and `perf.json` to
`~/.praxis-agent-state/cloud/reports/web-fix1/` (override with `OUT`).

The historical numbers in `cloud/docs/web/PERF.md` had no accompanying script and
are not validated by this change. This report supersedes those claims. No 500-model
frame-rate, displacement-cache, chat-switch, or SSE-to-DOM latency claim is made here.
`praxis:boot-to-paint` measures navigation start to the authenticated store layout
commit, including session verification and IDB loading; it is not a browser paint metric.

Measured on 2026-10-31 against the Vite development server:

- Light authenticated replica mount: 57.4 ms (one reload sample).
- Dark authenticated replica mount: 52.9 ms (one reload sample).

Header bounds in both themes: History x=18–58, title x=70–332, New x=344–384.
These samples belong to WP-B1, before WP-B3 layout/token changes. Current actions use native ink/canvas inversion; see cloud/docs/web/PARITY.md. No new WP-B3 timing claim is made.

WP-B5 sample (same development-server metric): light 84.9 ms, dark 83.8 ms; one reload each. Production JS is 727.20 kB (220.03 kB gzip), with the lab module and dev-auth module removed. This is not a production runtime latency benchmark.
