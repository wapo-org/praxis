# Web performance evidence

The previous report's 50.6/11.3/4.8/3.2/0.04 ms numbers had no accompanying script
and are not verified. They are withdrawn rather than presented as current measurements.

The reproducible [perf script](../../apps/web/scripts/perf.mjs) records authenticated
store-mount timing and visual bounds against the local API. Historical WP-B1 samples
and the exact meaning/limitations of that metric are in the
[app performance report](../../apps/web/PERF.md). These are not browser paint, SSE-to-DOM,
chat-switch, 500-model frame-rate, or displacement-cache benchmarks.

WP-B3 visual and navigation evidence is in [PARITY.md](PARITY.md).
