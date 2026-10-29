/**
 * Sync experiment: 1k chats / 50k messages, k ∈ {0, 1, 50} server changes since the replica last synced.
 * Measures round trips, bytes (JSON request+response bodies, no HTTP overhead), in-process time (client +
 * server compute, no network) and estimated wall time at 50 ms and 150 ms RTT. Run: npm run bench -w @praxis/sync
 */
import {HashTree, MemoryReplica, SyncSimulator, syncCursor, syncMerkle, type SyncRequest} from '../src/index.js';

const CHATS = 1000, MESSAGES = 50_000;
const text = (i: number) => `Message ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(12);
let seed = 42;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);

async function dataset() {
  const server = new SyncSimulator();
  for (let c = 0; c < CHATS; c++) await server.put(`chat:${c}`, {type: 'chat', id: String(c), title: `Chat ${c}`, mode: 'build', updatedAt: '2026-10-29T00:00:00.000Z'});
  for (let m = 0; m < MESSAGES; m++) await server.put(`message:${m}`, {type: 'message', id: String(m), chatId: String(m % CHATS), role: m % 2 ? 'assistant' : 'user', parts: [{type: 'text', text: text(m)}], createdAt: '2026-10-29T00:00:00.000Z'});
  return server;
}

async function cloneReplica(server: SyncSimulator) {
  const r = new MemoryReplica();
  const all = [...server.rows.values()].filter(e => !e.deleted).map(({revision: _r, ...e}) => e);
  await r.apply(all, [], String(server.revision));
  await r.tree.root();
  return r;
}

async function change(server: SyncSimulator, k: number) {
  for (let i = 0; i < k; i++) {
    const m = rand(MESSAGES);
    await server.put(`message:${m}`, {type: 'message', id: String(m), chatId: String(m % CHATS), role: 'assistant', parts: [{type: 'text', text: text(m) + ' (edited)'}], createdAt: '2026-10-29T00:00:00.000Z'});
  }
  await server.tree.root(); // server keeps its tree current on write; not charged to the sync
}

const rows: string[] = [];
const coldStart = performance.now();
const server = await dataset();
const loadMs = performance.now() - coldStart;
const treeStart = performance.now();
const cold = new HashTree();
for (const e of server.rows.values()) cold.set(e.key, e.hash);
await cold.root();
const coldTreeMs = performance.now() - treeStart;

for (const k of [0, 1, 50]) {
  for (const strategy of ['cursor', 'merkle'] as const) {
    const replica = await cloneReplica(server);
    await change(server, k);
    const transport = (r: SyncRequest) => server.handle(structuredClone(r));
    const t0 = performance.now();
    const stats = strategy === 'cursor' ? await syncCursor(transport, replica) : await syncMerkle(transport, replica);
    const ms = performance.now() - t0;
    if ((await replica.tree.root()) !== (await server.tree.root())) throw new Error(`${strategy} k=${k} did not converge`);
    const kb = (stats.requestBytes + stats.responseBytes) / 1024;
    rows.push(`| ${k} | ${strategy} | ${stats.roundTrips} | ${(stats.requestBytes / 1024).toFixed(1)} | ${(stats.responseBytes / 1024).toFixed(1)} | ${kb.toFixed(1)} | ${ms.toFixed(1)} | ${(ms + stats.roundTrips * 50).toFixed(0)} | ${(ms + stats.roundTrips * 150).toFixed(0)} |`);
  }
}
console.log(`Dataset: ${CHATS} chats + ${MESSAGES} messages (${server.rows.size} entities); seeded in ${loadMs.toFixed(0)} ms; cold server tree build ${coldTreeMs.toFixed(0)} ms. Node ${process.version}.`);
console.log('| k changes | strategy | round trips | request KB | response KB | total KB | compute ms | est. ms @50ms RTT | est. ms @150ms RTT |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
