import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {APPROVAL_RECORD_KIND, ApprovalRecordSchema, RunSnapshotSchema} from '@praxis/protocol';
import {createApp} from '../app.js';
import type {FeatureTool} from '../contracts.js';
import {createExecutionDriver} from '../execution.js';
import {createLocalAdapters} from '../local-memory.js';
import {ApiService} from '../service.js';
import {connectKey, delta, fakeOpenRouter} from './harness.js';

const USER = 'local-user';
const toolCall = [
  delta({tool_calls: [{index: 0, id: 'call_send', type: 'function', function: {name: 'send', arguments: '{}'}}]}),
  delta({}, 'tool_calls'),
];

/** Each parked run consumes one tool-call turn; later model turns fall back to a plain text reply. */
async function parkedRun(parkedTurns = 1) {
  const fake = fakeOpenRouter(Array.from({length: parkedTurns}, () => toolCall));
  const service = new ApiService(createLocalAdapters(), true);
  const scheduled: string[] = [];
  let executions = 0;
  const send: FeatureTool = {
    name: 'send', description: 'send', inputSchema: {type: 'object'}, source: {type: 'builtin'}, traits: ['sandboxed'],
    execute: async () => {
      executions++;
      return 'sent';
    },
  };
  const driver = createExecutionDriver({
    service, fetcher: fake.fetcher, features: {tools: async () => [send]},
    scheduler: {schedule: async (_user, runId) => { scheduled.push(runId); }},
  });
  service.driver = driver;
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), fetcher: fake.fetcher});
  const req = async (path: string, body?: unknown) => app.request(path, {
    method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  const snapshot = async (runId: string) =>
    RunSnapshotSchema.parse(await (await app.request(`/v1/runs/${runId}/snapshot`, {headers: {Authorization: 'Bearer dev-local'}})).json());
  await connectKey(req);
  const startRun = async () => {
    const chat = await (await req('/v1/chats', {type: 'chat.input', title: 'T', mode: 'build', modelId: 'm'})).json();
    const run = await (await req('/v1/runs', {type: 'run.start', chatId: chat.id, text: 'go'})).json();
    await service.drain();
    const parked = await snapshot(run.id);
    expect(parked.run.status).toBe('awaitingApproval');
    return {runId: String(run.id), approvalId: parked.pendingApprovals[0]!.id};
  };
  const {runId, approvalId} = await startRun();
  const decide = (decision: string, id = approvalId, run = runId) =>
    req(`/v1/runs/${run}/approvals`, {type: 'approval.decision', approvalId: id, decision});
  const cancel = () => req(`/v1/runs/${runId}/cancel`, {type: 'run.cancel'});
  const events = async (type: string) => (await service.adapters.events.read(USER, `run:${runId}`, 0, 500))
    .filter(event => (event.payload.event as {type: string}).type === type);
  const record = async () =>
    ApprovalRecordSchema.parse((await service.adapters.store.get(USER, APPROVAL_RECORD_KIND, approvalId))!.value);
  const deliver = async () => {
    for (const id of scheduled.splice(0)) await driver.continue(USER, id);
  };
  return {
    service, driver, runId, approvalId, scheduled, snapshot, decide, cancel, events, record, deliver, startRun,
    get executions() { return executions; },
  };
}

describe('PRA-56 approval decision races', () => {
  it('lets exactly one of two concurrent conflicting decisions win and executes only on allow', async () => {
    const f = await parkedRun();
    const [allow, deny] = await Promise.all([f.decide('allowOnce'), f.decide('deny')]);
    expect([allow.status, deny.status].sort()).toEqual([202, 409]);
    const loser = allow.status === 409 ? allow : deny;
    expect((await loser.json()).code).toBe('decision_conflict');
    const winner = allow.status === 202 ? 'allowOnce' : 'deny';
    expect(await f.record()).toMatchObject({decision: winner, status: winner === 'deny' ? 'denied' : 'approved'});
    expect(f.scheduled).toEqual([f.runId]);
    await f.deliver();
    expect(f.executions).toBe(winner === 'allowOnce' ? 1 : 0);
    expect(await f.events('approval.resolved')).toHaveLength(1);
    expect((await f.snapshot(f.runId)).run.status).toBe('completed');
  });

  it('acknowledges a replayed decision after completion without rescheduling or re-executing', async () => {
    const f = await parkedRun();
    expect((await f.decide('allowOnce')).status).toBe(202);
    await f.deliver();
    expect(f.executions).toBe(1);
    expect((await f.decide('allowOnce')).status).toBe(202);
    const conflict = await f.decide('deny');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('decision_conflict');
    expect(f.scheduled).toEqual([]);
    await f.driver.continue(USER, f.runId);
    expect(f.executions).toBe(1);
    expect(await f.events('approval.resolved')).toHaveLength(1);
  });

  it('refuses an approval id replayed against a different run', async () => {
    const f = await parkedRun(2);
    const other = await f.startRun();
    const replay = await f.decide('allowOnce', f.approvalId, other.runId);
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('decision_stale');
    expect(f.scheduled).toEqual([]);
    expect((await f.record()).status).toBe('pending');
    expect(f.executions).toBe(0);
  });
});

describe('PRA-56 approval and cancellation', () => {
  it('cancels a pending approval so a later redelivered continuation never executes the tool', async () => {
    const f = await parkedRun();
    expect((await (await f.cancel()).json()).status).toBe('cancelled');
    await f.driver.continue(USER, f.runId);
    expect(f.executions).toBe(0);
    expect((await f.snapshot(f.runId)).pendingApprovals).toEqual([]);
    expect(await f.events('run.finished')).toHaveLength(1);
    expect(await f.events('approval.resolved')).toHaveLength(0);
  });

  it('rejects an approval sent after cancellation and leaves the record undecided', async () => {
    const f = await parkedRun();
    await f.cancel();
    for (const decision of ['allowOnce', 'allowAlways', 'deny']) {
      const late = await f.decide(decision);
      expect(late.status).toBe(409);
      expect((await late.json()).code).toBe('decision_stale');
    }
    expect((await f.record()).status).toBe('pending');
    expect(f.scheduled).toEqual([]);
    await f.driver.continue(USER, f.runId);
    expect(f.executions).toBe(0);
    expect((await f.snapshot(f.runId)).run.outcome).toBe('cancelled');
  });

  it('does not execute an approval recorded before a cancel that beats its continuation', async () => {
    const f = await parkedRun();
    expect((await f.decide('allowOnce')).status).toBe(202);
    expect(f.scheduled).toEqual([f.runId]);
    expect((await (await f.cancel()).json()).status).toBe('cancelled');
    await f.deliver();
    expect(f.executions).toBe(0);
    expect((await f.snapshot(f.runId)).run.outcome).toBe('cancelled');
    expect(await f.events('run.finished')).toHaveLength(1);
    expect(await f.events('tool.running')).toHaveLength(0);
  });

  it('never executes when a cancel and an approval arrive concurrently', async () => {
    const f = await parkedRun();
    const [cancelled, decided] = await Promise.all([f.cancel(), f.decide('allowOnce')]);
    expect(cancelled.status).toBe(202);
    expect([202, 409]).toContain(decided.status);
    await f.deliver();
    expect(f.executions).toBe(0);
    expect((await f.snapshot(f.runId)).run.outcome).toBe('cancelled');
    expect(await f.events('run.finished')).toHaveLength(1);
  });
});
