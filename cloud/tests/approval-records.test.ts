import {expect, it, vi} from 'vitest';
import {APPROVAL_RECORD_KIND} from '@praxis/protocol';
import {api} from '../convex/_generated/api.js';
import {chatId, signedInUser, SERVER_TOKEN, workflowTest} from './workflow-fixture.js';

it('atomically records one immutable decision and scopes reads by owner', async () => {
  vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  try {
    const t = workflowTest();
    const owner = await signedInUser(t);
    const other = await signedInUser(t);
    await owner.client.mutation(api.chats.create, {input: {type: 'chat.input', id: chatId}});
    const now = new Date().toISOString();
    const runId = 'run';
    await t.mutation(api.store.put, {
      userId: owner.userId, serverToken: SERVER_TOKEN, kind: 'run', id: runId, parentId: chatId,
      valueJson: JSON.stringify({
        type: 'run', id: runId, chatId, status: 'awaitingApproval', lastEventId: 0, createdAt: now, updatedAt: now,
      }),
    });
    const pending = {
      id: 'approval', runId, toolCallId: 'call', tool: 'SLACK_SEND_MESSAGE',
      argsHash: 'a'.repeat(64), preview: '{ "channel": "#review" }', status: 'pending',
    };
    const address = {userId: owner.userId, serverToken: SERVER_TOKEN, kind: APPROVAL_RECORD_KIND, id: pending.id};
    const created = await t.mutation(api.store.putIfRevision, {
      ...address, parentId: runId, expectedRevision: 0, valueJson: JSON.stringify(pending),
    });
    expect(created?.value).toEqual(pending);
    const revision = created!.revision;
    const decide = (value: object) => t.mutation(api.store.putIfRevision, {
      ...address, parentId: runId, expectedRevision: revision, valueJson: JSON.stringify({...pending, ...value}),
    });
    await expect(decide({status: 'approved', decision: 'allowOnce', argsHash: 'b'.repeat(64)}))
      .rejects.toThrow('Invalid approval transition');
    const decisions = await Promise.all([
      decide({status: 'approved', decision: 'allowOnce'}),
      decide({status: 'denied', decision: 'deny'}),
    ]);
    expect(decisions.filter(row => row !== null)).toHaveLength(1);
    const saved = await t.query(api.store.get, address);
    expect(saved).toEqual(decisions.find(row => row !== null));
    await expect(t.query(api.store.get, {...address, userId: other.userId})).resolves.toBeNull();
    await expect(t.mutation(api.store.putIfRevision, {
      ...address, parentId: runId, expectedRevision: saved!.revision, valueJson: JSON.stringify(pending),
    })).rejects.toThrow('Invalid approval transition');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('refuses to record a decision once the run is cancelled', async () => {
  vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
  try {
    const t = workflowTest();
    const owner = await signedInUser(t);
    await owner.client.mutation(api.chats.create, {input: {type: 'chat.input', id: chatId}});
    const now = new Date().toISOString();
    const runId = 'run';
    const putRun = (status: string) => t.mutation(api.store.put, {
      userId: owner.userId, serverToken: SERVER_TOKEN, kind: 'run', id: runId, parentId: chatId,
      valueJson: JSON.stringify({type: 'run', id: runId, chatId, status, lastEventId: 0, createdAt: now, updatedAt: now}),
    });
    await putRun('awaitingApproval');
    const pending = {
      id: 'approval', runId, toolCallId: 'call', tool: 'GMAIL_SEND_EMAIL',
      argsHash: 'c'.repeat(64), preview: '{ "to": "a@example.test" }', status: 'pending',
    };
    const address = {userId: owner.userId, serverToken: SERVER_TOKEN, kind: APPROVAL_RECORD_KIND, id: pending.id};
    const created = await t.mutation(api.store.putIfRevision, {
      ...address, parentId: runId, expectedRevision: 0, valueJson: JSON.stringify(pending),
    });
    await putRun('cancelled');
    await expect(t.mutation(api.store.putIfRevision, {
      ...address, parentId: runId, expectedRevision: created!.revision,
      valueJson: JSON.stringify({...pending, status: 'approved', decision: 'allowOnce'}),
    })).rejects.toThrow('Approval run unavailable');
    await expect(t.query(api.store.get, address)).resolves.toMatchObject({value: pending});
  } finally {
    vi.unstubAllEnvs();
  }
});
