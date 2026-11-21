// Sums convex-test's per-document read/write metrics for a scripted chat, to compare with the Convex dashboard (PRA-26).
import {randomBytes} from 'node:crypto';
import {TransactionMetricsTracker} from 'convex-test/dist/transactionMetrics.js';
import {api, internal} from '../convex/_generated/api.js';
import {writeRecord} from '../convex/store.js';
import {ENCRYPTION_KEYRING_ENV, MODEL_KEY_ID, MODEL_KEY_KIND, MODEL_KEY_RESOURCE} from '../convex/agent/constants.js';
import {seal} from '../apps/api/src/secrets.js';
import {startedRun} from '../tests/workflow-fixture.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Decimal 1 GB: the Free/Starter monthly Database I/O allowance. */
export const MONTHLY_IO_BUDGET_BYTES = 1_000_000_000;
const MODEL_KEY = 'sk-or-v1-io-replay-key';
const CLIENT_PAGE_SIZE = 100;
const NOW = '2026-11-21T00:00:00.000Z';
const SIGNED = {type: 'reasoning.text', text: 'Think about the next step.', signature: 'sig-io-replay', format: 'anthropic-claude-v1', index: 0};

export interface IoTotals {
  documentsRead: number;
  bytesRead: number;
  documentsWritten: number;
  bytesWritten: number;
}
export interface IoReport {
  turns: number;
  /** Workflow steps: hydrate, ledger, commit, receipts. */
  turn: IoTotals;
  /** One `messages.page` re-run per committed turn, as a subscribed client would. */
  client: IoTotals;
  total: IoTotals;
}

const zero = (): IoTotals => ({documentsRead: 0, bytesRead: 0, documentsWritten: 0, bytesWritten: 0});
let meter: IoTotals = zero();

/** Every convex-test transaction reports its reads and writes here, so nested `runQuery`/`runMutation` calls count once. */
function installMeter() {
  const proto = TransactionMetricsTracker.prototype;
  const {trackRead, trackWrite} = proto;
  proto.trackRead = function read(this: TransactionMetricsTracker, bytes: number) {
    meter.documentsRead++;
    meter.bytesRead += bytes;
    trackRead.call(this, bytes);
  };
  proto.trackWrite = function write(this: TransactionMetricsTracker, bytes: number) {
    meter.documentsWritten++;
    meter.bytesWritten += bytes;
    trackWrite.call(this, bytes);
  };
  return () => {
    proto.trackRead = trackRead;
    proto.trackWrite = trackWrite;
  };
}

async function measured(into: IoTotals, work: () => Promise<unknown>) {
  meter = zero();
  await work();
  for (const key of Object.keys(into) as Array<keyof IoTotals>) into[key] += meter[key];
}

/** Turns before the last answer with a tool call (its result goes back next turn); the last one answers with text. */
function completion(turnIndex: number, last: boolean) {
  const text = `Step ${turnIndex}: ${'progress '.repeat(40)}`;
  const message = last
    ? {role: 'assistant', content: text, reasoning_details: [SIGNED]}
    : {role: 'assistant', content: text, reasoning_details: [SIGNED],
      tool_calls: [{id: `call-${turnIndex}`, type: 'function', function: {name: 'lookup', arguments: '{"query":"next"}'}}]};
  return {
    id: `gen-${turnIndex}`, object: 'chat.completion', created: 1_800_000_000, model: 'anthropic/claude-sonnet-5.5',
    choices: [{index: 0, finish_reason: last ? 'stop' : 'tool_calls', message}],
    usage: {prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100, cost: 0.001},
  };
}

function fakeOpenRouter(turns: number) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url !== OPENROUTER_URL) throw new Error(`Unexpected fetch to ${request.url}`);
    const body = await request.json() as {messages: Array<{role: string}>};
    const turnIndex = body.messages.filter(message => message.role === 'assistant').length;
    return Response.json(completion(turnIndex, turnIndex + 1 >= turns));
  };
}

/** One chat, one run, `turns` workflow turns with a subscribed client; returns documents and bytes read and written. */
export async function replaySession(turns: number): Promise<IoReport> {
  const keyring = randomBytes(32).toString('base64');
  const previous = {fetch: globalThis.fetch, keyring: process.env[ENCRYPTION_KEYRING_ENV]};
  process.env[ENCRYPTION_KEYRING_ENV] = keyring;
  globalThis.fetch = fakeOpenRouter(turns);
  const uninstall = installMeter();
  try {
    const {t, owner, userId, scope} = await startedRun();
    await t.run(async ctx => {
      const sealed = seal(MODEL_KEY, userId, MODEL_KEY_RESOURCE, keyring);
      await writeRecord(ctx, {userId, kind: MODEL_KEY_KIND, id: MODEL_KEY_ID, deleted: false,
        value: {type: 'modelKey', maskedKey: '••••-key', connectedAt: NOW, sealed}});
      await writeRecord(ctx, {userId, kind: 'message', id: 'prompt', parentId: scope.chatId, deleted: false,
        value: {type: 'message', id: 'prompt', chatId: scope.chatId, role: 'user',
          parts: [{type: 'text', text: 'Plan and carry out the task.'}], createdAt: NOW, updatedAt: NOW}});
    });
    const report: IoReport = {turns, turn: zero(), client: zero(), total: zero()};
    for (let expectedTurnIndex = 0; expectedTurnIndex < turns; expectedTurnIndex++) {
      await measured(report.turn, () => t.action(internal.turns.run, {...scope, expectedTurnIndex}));
      await measured(report.client, () => owner.query(api.messages.page, {chatId: scope.chatId, limit: CLIENT_PAGE_SIZE}));
    }
    for (const key of Object.keys(report.total) as Array<keyof IoTotals>) {
      report.total[key] = report.turn[key] + report.client[key];
    }
    return report;
  } finally {
    uninstall();
    globalThis.fetch = previous.fetch;
    if (previous.keyring === undefined) delete process.env[ENCRYPTION_KEYRING_ENV];
    else process.env[ENCRYPTION_KEYRING_ENV] = previous.keyring;
  }
}

export function formatReport(report: IoReport): string {
  const row = (label: string, io: IoTotals) =>
    `${label.padEnd(8)} ${String(io.documentsRead).padStart(8)} ${String(io.bytesRead).padStart(12)} `
    + `${String(io.documentsWritten).padStart(8)} ${String(io.bytesWritten).padStart(12)}`;
  const bytes = report.total.bytesRead + report.total.bytesWritten;
  return [
    `Scripted session: ${report.turns} turns (convex-test transaction metrics, not hosted billing counters)`,
    `${'scope'.padEnd(8)} ${'docs read'.padStart(8)} ${'bytes read'.padStart(12)} ${'docs wr.'.padStart(8)} ${'bytes wr.'.padStart(12)}`,
    row('turn', report.turn),
    row('client', report.client),
    row('total', report.total),
    `I/O bytes: ${bytes}; sessions per ${MONTHLY_IO_BUDGET_BYTES} B month: ${Math.floor(MONTHLY_IO_BUDGET_BYTES / bytes)}`,
  ].join('\n');
}
