#!/usr/bin/env node
// Billing basis: https://docs.convex.dev/production/state/limits#database

// Index accounting basis: https://docs.convex.dev/production/integrations/log-streams#function_execution-events

// Cache sharing basis: https://docs.convex.dev/realtime#automatic-caching
import { pathToFileURL } from 'node:url';

export const DEFAULTS = Object.freeze({
  durationMs: 60_000,
  tokensPerSecond: 50,
  token: 'word',
  flushMs: 500,
  subscribers: 1,
  shareQueryCache: false,
  budgetBytes: 1_000_000_000,
  documentOverheadBytes: 128,
  indexCount: 3,
  indexEntryBytes: 64,
});

export const ASSUMPTIONS = Object.freeze({
  serialization: 'UTF-8 payload + fixed document overhead approximates Convex encoding; not measured.',
  patches: 'Each patch reads the old document and writes the full new document, not just the network delta.',
  indexes: 'Index entries cost indexEntryBytes each, including two built-ins; payload is not indexed.',
  indexChanges: 'Index keys stay fixed; no extra stale-key removal except at deletion.',
  cleanup: 'Temporary rows are read then deleted; deletion writes one index entry per index and no payload.',
  queries: 'Every flush is observed; isolated queries re-read per subscriber, shared cache executes once.',
  deltas: 'Cursor queries read only newly inserted chunks; final assembly reads every chunk once.',
  redis: 'Only final Convex commit/read counts here; Redis bytes are payload only, not its bill.',
  scope: 'Excludes auth, workflow, history, tools, retries, OCC, egress, and other monthly usage.',
});

const MILLISECONDS_PER_SECOND = 1_000;
const SUBSCRIBER_COUNTS = [1, 2, 3];
const STRATEGIES = ['cumulative', 'deltas', 'redis'];

export function calculate(options = {}) {
  const config = { ...DEFAULTS, ...options };
  for (const key of ['durationMs', 'tokensPerSecond', 'flushMs', 'budgetBytes']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new RangeError(key);
  }
  for (const key of ['subscribers', 'documentOverheadBytes', 'indexCount', 'indexEntryBytes']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 0) throw new RangeError(key);
  }
  if (typeof config.token !== 'string' || config.token.length === 0) throw new TypeError('token');
  if (typeof config.shareQueryCache !== 'boolean') throw new TypeError('shareQueryCache');
  const totalTokens = Math.floor(config.durationMs * config.tokensPerSecond / MILLISECONDS_PER_SECOND);
  const tokenBytes = Buffer.byteLength(config.token);
  const payloadBytes = totalTokens * tokenBytes;
  const readers = config.shareQueryCache ? Math.min(1, config.subscribers) : config.subscribers;
  const indexBytes = config.indexCount * config.indexEntryBytes;
  const documentBytes = bytes => bytes + config.documentOverheadBytes;
  const rows = Object.fromEntries(STRATEGIES.map(strategy => [strategy, {
    strategy, readBytes: 0, writeBytes: 0, writes: 0, redisPayloadBytes: 0,
  }]));
  let previousTokens = 0;
  let previousDocumentBytes = 0;
  let chunkDocumentsBytes = 0;
  let flushes = 0;
  const intervals = Math.ceil(config.durationMs / config.flushMs);
  for (let interval = 1; interval <= intervals; interval++) {
    const elapsedMs = Math.min(interval * config.flushMs, config.durationMs);
    const tokens = Math.floor(elapsedMs * config.tokensPerSecond / MILLISECONDS_PER_SECOND);
    if (tokens === previousTokens) continue;
    const cumulativeBytes = documentBytes(tokens * tokenBytes);
    const deltaBytes = documentBytes((tokens - previousTokens) * tokenBytes);
    rows.cumulative.readBytes += previousDocumentBytes + readers * cumulativeBytes;
    rows.cumulative.writeBytes += cumulativeBytes + indexBytes;
    rows.deltas.readBytes += readers * (deltaBytes + indexBytes);
    rows.deltas.writeBytes += deltaBytes + indexBytes;
    chunkDocumentsBytes += deltaBytes;
    previousDocumentBytes = cumulativeBytes;
    previousTokens = tokens;
    flushes++;
  }
  for (const row of Object.values(rows)) {
    const finalBytes = documentBytes(payloadBytes);
    row.readBytes += readers * finalBytes;
    row.writeBytes += finalBytes + indexBytes;
    row.writes = row.strategy === 'redis' ? 1 : flushes * 2 + 1;
  }
  if (flushes > 0) {
    rows.cumulative.readBytes += previousDocumentBytes;
    rows.cumulative.writeBytes += indexBytes;
    rows.deltas.readBytes += chunkDocumentsBytes + flushes * indexBytes;
    rows.deltas.writeBytes += flushes * indexBytes;
  }
  rows.redis.redisPayloadBytes = payloadBytes * (1 + config.subscribers);
  return {
    config, totalTokens, payloadBytes, flushes,
    rows: Object.values(rows).map(row => {
      const totalBytes = row.readBytes + row.writeBytes;
      return { ...row, totalBytes, responsesPerMonth: Math.floor(config.budgetBytes / totalBytes) };
    }),
  };
}

export function main(args = process.argv.slice(2)) {
  const [flushArg = String(DEFAULTS.flushMs), durationArg = String(DEFAULTS.durationMs)] = args;
  console.log('MODELLED Convex database I/O; no deployment measurement. Usage: node stream-io.mjs [flushMs] [durationMs]');
  console.log(ASSUMPTIONS);
  const table = [];
  for (const shareQueryCache of [false, true]) {
    for (const subscribers of SUBSCRIBER_COUNTS) {
      const result = calculate({ flushMs: Number(flushArg), durationMs: Number(durationArg), subscribers, shareQueryCache });
      for (const row of result.rows) table.push({
        cache: shareQueryCache ? 'shared' : 'isolated', subscribers,
        ...row,
      });
    }
  }
  console.table(table);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
