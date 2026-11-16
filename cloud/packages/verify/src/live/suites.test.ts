import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadSuite} from './command.js';
import {runSuite} from './runner.js';

const HOSTED = {PRAXIS_LIVE_API_URL: 'https://api.example.test', PRAXIS_LIVE_TOKEN: 'live-session-token-0123456789', OPENROUTER_LIVE_KEY: 'sk-or-v1-livekey0123456789abcdef'};
const NOW = '2026-11-16T22:00:00.000Z';
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

async function run(suiteId: string, stepId: string, env: Record<string, string>, reply: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => Response.json(reply(String(url), init))));
  const directory = mkdtempSync(join(tmpdir(), 'praxis-verify-suite-'));
  directories.push(directory);
  const {proof} = await runSuite(await loadSuite(suiteId), {env, evidence: new Map(), only: [stepId], directory});
  return proof.steps.find(step => step.id === stepId)!;
}

const run_ = {type: 'run', id: 'r1', chatId: 'c1', status: 'completed', createdAt: NOW, updatedAt: NOW, lastEventId: 3};
const snapshot = (extra: Record<string, unknown>) => ({type: 'run.snapshot', run: run_, lastEventId: 3, blocks: [], tools: [], pendingApprovals: [], pendingElicitations: [], messages: [], ...extra});
const block = (type: 'text' | 'reasoning', text: string) => ({type, id: `${type}-1`, text, finished: true});
const chat = {type: 'chat', id: 'c1', title: 'x', pinned: false, mode: 'build', modelId: 'm', effort: 'high', connectorIds: [], disabledConnectorIds: [], createdAt: NOW, updatedAt: NOW};

describe('openrouter suite', () => {
  it('fails a turn whose snapshot violates the protocol instead of passing it', async () => {
    const step = await run('openrouter', 'chat-turn', HOSTED, url => (url.endsWith('/v1/chats') ? chat : url.endsWith('/v1/runs') ? run_ : {run: {id: 'r1', status: 'completed'}, blocks: [{type: 'text', text: 'pong'}]}));
    expect(step.status).toBe('fail');
    expect(step.summary).toMatch(/violates the protocol/);
  });

  it('fails tools-reasoning when the model answered 42 without a tool call or reasoning', async () => {
    const step = await run('openrouter', 'tools-reasoning', HOSTED, url => (url.endsWith('/v1/chats') ? chat : url.endsWith('/v1/runs') ? run_ : snapshot({blocks: [block('text', '42')]})));
    expect(step.status).toBe('fail');
    expect(step.summary).toMatch(/no tool call succeeded; no reasoning block/);
  });

  it('passes tools-reasoning only with a succeeded tool, reasoning, a signed stored reasoning part and a completed follow-up', async () => {
    const tool = {type: 'tool.state', activity: {type: 'tool.activity', id: 't1', name: 'run_javascript', source: {type: 'javascript'}, presentation: {category: 'command', runningTitle: 'Running', finishedTitle: 'Ran'}}, argumentsJson: '{}', running: false, completion: {type: 'tool.completion', status: 'succeeded', summary: '42', preview: '42'}, progress: []};
    const message = {type: 'message', id: 'm1', chatId: 'c1', runId: 'r1', role: 'assistant', parts: [{type: 'reasoning', text: 'think', signature: 'sig'}], createdAt: NOW, updatedAt: NOW};
    const step = await run('openrouter', 'tools-reasoning', HOSTED, url => {
      if (url.endsWith('/v1/chats')) return chat;
      if (url.endsWith('/v1/runs')) return run_;
      if (url.includes('/messages')) return {type: 'page', items: [message], nextCursor: null};
      return snapshot({blocks: [block('reasoning', 'think'), block('text', '42')], tools: [tool]});
    });
    expect(step.summary).not.toMatch(/violates/);
    expect(step.status).toBe('pass');
  });

  it('turns a rejected paste into a pass only for 400 model_key_rejected', async () => {
    const rejected = await run('openrouter', 'reject-foreign-key', HOSTED, () => ({type: 'error', code: 'model_key_rejected', message: 'This is not an OpenRouter key.'}));
    expect(rejected.status).toBe('fail');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({type: 'error', code: 'model_key_rejected', message: 'nope'}, {status: 400})));
    const directory = mkdtempSync(join(tmpdir(), 'praxis-verify-suite-'));
    directories.push(directory);
    const {proof} = await runSuite(await loadSuite('openrouter'), {env: HOSTED, evidence: new Map(), only: ['reject-foreign-key'], directory});
    expect(proof.steps.find(step => step.id === 'reject-foreign-key')!.status).toBe('pass');
  });
});

describe('credential-pool suite', () => {
  const env = {UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'upstash-token-0123456789', GROQ_API_KEY: 'gsk_slotone0123456789abcdefghij'};
  const upstash = (ttl: unknown, value: unknown) => (_url: string, init?: RequestInit) => (JSON.parse(String(init?.body))[0] === 'TTL' ? ttl : value);

  it('fails the cooldown step on an Upstash error envelope or a non-integer TTL', async () => {
    expect((await run('credential-pool', 'cooldown', env, upstash({error: 'ERR fixture'}, {result: null}))).summary).toMatch(/Upstash TTL failed: ERR fixture/);
    expect((await run('credential-pool', 'cooldown', env, upstash({result: 'soon'}, {result: null}))).status).toBe('fail');
  });

  it('passes only a live TTL whose value holds no key material', async () => {
    expect((await run('credential-pool', 'cooldown', env, upstash({result: 30}, {result: 'rateLimited'}))).status).toBe('pass');
    expect((await run('credential-pool', 'cooldown', env, upstash({result: -2}, {result: null}))).status).toBe('fail');
    expect((await run('credential-pool', 'cooldown', env, upstash({result: 30}, {result: `leak ${env.GROQ_API_KEY}`}))).summary).toMatch(/contains key material/);
  });
});
