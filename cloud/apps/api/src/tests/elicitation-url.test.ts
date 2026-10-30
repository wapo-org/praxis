import {describe, expect, it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {RunEventSchema, RunSnapshotSchema} from '@praxis/protocol';
import {createApp} from '../app.js';
import {createLocalAdapters} from '../local-memory.js';
import {localDriver} from '../runtime.js';
import {ApiService} from '../service.js';

function setup() {
  const service = new ApiService(createLocalAdapters(), true);
  service.driver = localDriver(service);
  const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64')});
  const req = async (path: string, body?: unknown) =>
    app.request(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  return {service, req};
}

describe('scripted URL elicitation (script elicitationURL)', () => {
  it.each([['accept', 'completed'], ['decline', 'completed']] as const)('parks with a protocol v1 url elicitation and resumes on %s', async (action, outcome) => {
    const f = setup();
    const run = await (await f.req('/v1/runs', {type: 'run.start', chatId: 'welcome', text: 'Connect', script: 'elicitationURL'})).json();
    await f.service.drain();
    const parked = RunSnapshotSchema.parse(await (await f.req(`/v1/runs/${run.id}/snapshot`)).json());
    expect(parked.run.status).toBe('awaitingElicitation');
    const elicitation = parked.pendingElicitations[0]!;
    expect(elicitation).toMatchObject({type: 'elicitation', mode: 'url', url: 'https://example.com/praxis/local-oauth?state=scripted-elicitation', connectorId: 'local-connector', connectorName: 'Local Connector', message: 'Sign in to Local Connector to continue.'});
    expect(elicitation.callId).toBeTruthy();

    const events = (await f.service.adapters.events.read('local-user', `run:${run.id}`, 0, 500)).map(e => RunEventSchema.parse({type: 'run.event', id: e.id, runId: run.id, chatId: 'welcome', createdAt: e.payload.createdAt, event: e.payload.event}).event);
    expect(events.find(e => e.type === 'elicitation.requested')).toMatchObject({elicitation: {mode: 'url'}});

    expect((await f.req(`/v1/runs/${run.id}/elicitations`, {type: 'elicitation.response', elicitationId: elicitation.id, action})).status).toBe(202);
    await f.service.drain();
    const done = RunSnapshotSchema.parse(await (await f.req(`/v1/runs/${run.id}/snapshot`)).json());
    expect(done.run.outcome).toBe(outcome);
    expect(JSON.stringify(done.tools)).toContain(action === 'accept' ? 'sign-in completed' : 'sign-in declined');
  });
});
