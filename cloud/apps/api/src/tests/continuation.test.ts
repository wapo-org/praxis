import {describe, expect, it} from 'vitest';
import {createHash, createHmac, randomBytes, randomUUID} from 'node:crypto';
import {RunSnapshotSchema} from '@praxis/protocol';
import {createQStashScheduler, createQStashVerifier} from '../adapters/qstash.js';
import {memoryLease} from '../execution.js';
import {createLocalAdapters} from '../local-memory.js';
import {createPraxisApp} from '../server.js';

const CALLBACK = 'https://api.praxis.test/internal/continue';
const KEYS = {currentSigningKey: 'sig_current_test_key', nextSigningKey: 'sig_next_test_key'};
const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/** Signs like QStash: HS256 JWT, iss Upstash, sub = callback URL, body = base64url(sha256(body)). */
function sign(body: string, key = KEYS.currentSigningKey, url = CALLBACK) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({alg: 'HS256', typ: 'JWT'}));
  const payload = b64(JSON.stringify({iss: 'Upstash', sub: url, iat: now, nbf: now, exp: now + 300, jti: randomUUID(), body: b64(createHash('sha256').update(body).digest())}));
  return `${header}.${payload}.${b64(createHmac('sha256', key).update(`${header}.${payload}`).digest())}`;
}

describe('QStash continuation across invocations', () => {
  it('a tiny budget hands the run to new invocations; duplicate deliveries add no events', async () => {
    const adapters = createLocalAdapters(); // shared durable storage
    const lease = memoryLease(); // stands in for the shared Redis lease
    const published: unknown[] = [];
    const scheduler = createQStashScheduler({callbackUrl: CALLBACK, client: {publishJSON: async (req: {body?: unknown}) => { published.push(req.body); return {messageId: randomUUID()} as never; }}});
    let now = 0;
    const instance = () => createPraxisApp({
      adapters, local: true, encryptionKey: randomBytes(32).toString('base64'), scheduler, lease,
      budgetMs: 500, clock: () => (now += 1000),
      continuation: {path: '/internal/continue', verify: createQStashVerifier({...KEYS, callbackUrl: CALLBACK})},
    });
    const first = instance();
    const run = await (await first.app.request('/v1/runs', {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify({type: 'run.start', chatId: 'welcome', text: 'Hi', script: 'tools'})})).json();
    await first.service.drain();
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual({type: 'run.continue', userId: 'local-user', runId: run.id});

    let deliveries = 0;
    while (published.length) {
      const body = JSON.stringify(published.shift());
      const next = instance(); // a fresh invocation: new driver, nothing in memory but the shared adapters
      for (let copy = 0; copy < 2; copy++) { // QStash is at-least-once
        const res = await next.app.request(CALLBACK.replace('https://api.praxis.test', ''), {method: 'POST', headers: {'upstash-signature': sign(body), 'content-type': 'application/json'}, body});
        expect(res.status).toBe(200);
        deliveries++;
      }
      await next.service.drain();
      if (deliveries > 40) throw new Error('run never finished');
    }
    expect(deliveries).toBeGreaterThanOrEqual(2);

    const snapshot = RunSnapshotSchema.parse(await (await first.app.request(`/v1/runs/${run.id}/snapshot`, {headers: {Authorization: 'Bearer dev-local'}})).json());
    expect(snapshot.run.outcome).toBe('completed');
    const events = await adapters.events.read('local-user', `run:${run.id}`, 0, 1000);
    expect(events.map(e => e.id)).toEqual(events.map((_, i) => i + 1)); // nothing lost, ids contiguous
    const types = events.map(e => (e.payload.event as {type: string}).type);
    expect(types.filter(t => t === 'run.finished')).toHaveLength(1);
    expect(types.filter(t => t === 'tool.finished')).toHaveLength(1);
    expect(types.filter(t => t === 'run.parked')).toEqual(expect.arrayContaining(['run.parked']));
    const committed = events.flatMap(e => {
      const ev = e.payload.event as {type: string; messages?: {id: string}[]};
      return ev.type === 'messages.committed' ? ev.messages!.map(m => m.id) : [];
    });
    expect(new Set(committed).size).toBe(committed.length); // no message delivered twice
  });

  it('rejects missing, forged, wrong-subject and tampered deliveries before touching any run', async () => {
    const {app} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), continuation: {path: '/internal/continue', verify: createQStashVerifier({...KEYS, callbackUrl: CALLBACK})}});
    const body = JSON.stringify({type: 'run.continue', userId: 'local-user', runId: 'r'});
    const post = (headers: Record<string, string>, payload = body) => app.request('/internal/continue', {method: 'POST', headers, body: payload});
    expect((await post({})).status).toBe(401);
    expect((await post({'upstash-signature': sign(body, 'attacker-key')})).status).toBe(401);
    expect((await post({'upstash-signature': sign(body, KEYS.currentSigningKey, 'https://evil.test/x')})).status).toBe(401);
    expect((await post({'upstash-signature': sign(body)}, body.replace('"r"', '"other"'))).status).toBe(401);
    expect((await post({'upstash-signature': sign(body, KEYS.nextSigningKey)})).status).toBe(200); // rotated key accepted
  });
});
