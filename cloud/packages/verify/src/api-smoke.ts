import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BootstrapSchema, ChatSchema, ModelListItemSchema, PageSchema, RunSchema, RunSnapshotSchema, type RunSnapshot} from '@praxis/protocol';
import type {z} from 'zod';
import {setTimeout as sleep} from 'node:timers/promises';
import {API_REQUEST_TIMEOUT_MS} from './constants.js';
import {artifactDir, newRunId} from './run-context.js';
import {startApi} from './web/servers.js';

/** Local dev accepts this bearer for the seeded user; hosted APIs reject it. */
const DEV_BEARER = 'Bearer dev-local';
const APPROVAL_POLL_ATTEMPTS = 100;
const APPROVAL_POLL_INTERVAL_MS = 10;

interface ApiCheck {
  id: string;
  run(client: ApiClient, state: Map<string, string>): Promise<void>;
}

export class ApiClient {
  constructor(readonly base: string) {}

  /** Parses with the protocol schema, so a response that breaks the client contract fails the check. */
  async json<S extends z.ZodType>(path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    const response = await fetch(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: DEV_BEARER, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
    assert(response.ok, `${path}: HTTP ${response.status} ${await response.clone().text()}`);
    const parsed = schema.safeParse(await response.json());
    assert(parsed.success, `${path}: response violates the protocol: ${parsed.error?.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
    return parsed.data;
  }

  async events(runId: string, headers: Record<string, string> = {}): Promise<string> {
    const response = await fetch(`${this.base}/v1/runs/${runId}/events`, {headers: {Authorization: DEV_BEARER, ...headers}, signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS)});
    assert(response.ok, `events ${runId}: HTTP ${response.status}`);
    return response.text();
  }
}

/** Polls the run snapshot until it has a pending approval or the attempts run out. */
async function parkedSnapshot(client: ApiClient, runId: string): Promise<RunSnapshot> {
  let snapshot = await client.json(`/v1/runs/${runId}/snapshot`, RunSnapshotSchema);
  for (let attempt = 1; attempt < APPROVAL_POLL_ATTEMPTS && !snapshot.pendingApprovals.length; attempt++) {
    await sleep(APPROVAL_POLL_INTERVAL_MS);
    snapshot = await client.json(`/v1/runs/${runId}/snapshot`, RunSnapshotSchema);
  }
  return snapshot;
}

const need = (state: Map<string, string>, key: string) => {
  const value = state.get(key);
  assert(value, `${key} missing: an earlier check failed`);
  return value;
};

/** Former `apps/api/scripts/smoke-local.mjs`, one named check per behaviour. */
export const API_CHECKS: readonly ApiCheck[] = [
  {id: 'bootstrap', async run(client) {
    const bootstrap = await client.json('/v1/bootstrap', BootstrapSchema);
    assert(bootstrap.user.id, 'bootstrap has no user');
  }},
  {id: 'models', async run(client) {
    const models = await client.json('/v1/models?q=scripted', PageSchema(ModelListItemSchema));
    assert(models.items.some(model => model.id === 'scripted'), 'local catalogue lacks the scripted model');
  }},
  {id: 'chat', async run(client, state) {
    const chat = await client.json('/v1/chats', ChatSchema, {type: 'chat.input', title: 'praxis-verify api'});
    state.set('chatId', chat.id);
    // Build mode runs destructive tools without asking; the approval check needs a chat that asks.
    const asking = await client.json('/v1/chats', ChatSchema, {type: 'chat.input', title: 'praxis-verify approvals', mode: 'auto'});
    state.set('approvalChatId', asking.id);
  }},
  {id: 'text-sse', async run(client, state) {
    const run = await client.json('/v1/runs', RunSchema, {type: 'run.start', chatId: need(state, 'chatId'), text: 'Hello HTTP', clientTurnId: randomUUID()});
    const events = await client.events(run.id);
    assert(events.includes('run.finished'), 'stream never finished');
    assert(events.includes('Hello HTTP'), 'stream lacks the prompt echo');
    state.set('textRunId', run.id);
  }},
  {id: 'snapshot', async run(client, state) {
    const snapshot = await client.json(`/v1/runs/${need(state, 'textRunId')}/snapshot`, RunSnapshotSchema);
    assert.equal(snapshot.run.status, 'completed');
    assert(snapshot.blocks.some(block => block.text.includes('Hello HTTP')), 'snapshot lacks the reply');
  }},
  {id: 'nested-approval', async run(client, state) {
    const run = await client.json('/v1/runs', RunSchema, {type: 'run.start', chatId: need(state, 'approvalChatId'), text: 'Nested approval', script: 'nestedApproval'});
    const parked = await parkedSnapshot(client, run.id);
    const approval = parked.pendingApprovals[0];
    assert(approval, 'nested tool never asked for approval');
    assert(approval.parentCallId, 'nested approval lost its parentCallId');
    await client.json(`/v1/runs/${run.id}/approvals`, RunSchema, {type: 'approval.decision', approvalId: approval.id, decision: 'allowOnce'});
    assert((await client.events(run.id)).includes('run.finished'), 'approved run never finished');
  }},
  {id: 'tainted-approval', async run(client) {
    // A fresh chat: earlier connector results in the shared approval chat would already taint the run.
    const chat = await client.json('/v1/chats', ChatSchema, {type: 'chat.input', title: 'praxis-verify taint', mode: 'auto'});
    const run = await client.json('/v1/runs', RunSchema, {type: 'run.start', chatId: chat.id, text: 'Read then write', script: 'taintedApproval'});
    const parked = await parkedSnapshot(client, run.id);
    const approval = parked.pendingApprovals[0];
    assert(approval, 'write after an untrusted read never asked for approval');
    assert.equal(approval.taintSource, 'local fetch', 'approval lacks the taint source');
    assert.equal(parked.run.taint?.source, 'local fetch', 'run row lacks the persisted taint');
    await client.json(`/v1/runs/${run.id}/approvals`, RunSchema, {type: 'approval.decision', approvalId: approval.id, decision: 'deny'});
    assert((await client.events(run.id)).includes('run.finished'), 'denied run never finished');
  }},
  {id: 'disconnect-cancel-replay', async run(client, state) {
    const run = await client.json('/v1/runs', RunSchema, {type: 'run.start', chatId: need(state, 'chatId'), text: 'Disconnect and cancel', script: 'long'});
    const stream = await fetch(`${client.base}/v1/runs/${run.id}/events`, {headers: {Authorization: DEV_BEARER}});
    const reader = stream.body!.getReader();
    assert((await reader.read()).value?.length, 'no first event');
    await reader.cancel();
    await client.json(`/v1/runs/${run.id}/cancel`, RunSchema, {type: 'run.cancel'});
    const resumed = await client.events(run.id, {'Last-Event-ID': '1'});
    assert(resumed.includes('cancelled'), 'replay lacks the cancellation');
    assert(!resumed.includes('id: 1\n'), 'replay repeated an event the client already had');
  }},
];

export interface ApiReport {
  type: 'verify.api';
  runId: string;
  ok: boolean;
  api: string;
  checks: {id: string; ok: boolean; ms: number; error?: string}[];
}

export async function runApiSmoke(options: {api?: string; port: number; json: boolean}, print: (line: string) => void = line => console.log(line)): Promise<ApiReport> {
  const runId = newRunId();
  const started = options.api ? undefined : await startApi(options.port, artifactDir('verify', runId));
  const client = new ApiClient((options.api ?? started!.api).replace(/\/$/, ''));
  const state = new Map<string, string>();
  const checks: ApiReport['checks'] = [];
  try {
    for (const check of API_CHECKS) {
      const begin = Date.now();
      try {
        await check.run(client, state);
        checks.push({id: check.id, ok: true, ms: Date.now() - begin});
      } catch (error) {
        checks.push({id: check.id, ok: false, ms: Date.now() - begin, error: error instanceof Error ? error.message : String(error)});
      }
      const last = checks.at(-1)!;
      if (!options.json) print(`${last.ok ? 'PASS' : 'FAIL'} ${last.id.padEnd(26)} ${`${last.ms}ms`.padStart(7)}${last.error ? `\n    | ${last.error}` : ''}`);
    }
  } finally {
    await started?.server.stop();
  }
  const report: ApiReport = {type: 'verify.api', runId, ok: checks.every(check => check.ok), api: client.base, checks};
  print(options.json ? JSON.stringify(report) : `${report.ok ? 'api: ok' : 'api: FAILED'} (${checks.filter(check => check.ok).length}/${checks.length} checks)`);
  return report;
}
