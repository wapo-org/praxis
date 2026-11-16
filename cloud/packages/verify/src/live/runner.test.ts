import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {loadSuite, parseEvidence} from './command.js';
import {ProofSchema} from './proof.js';
import {Redactor} from './redact.js';
import {missingNeed, runSuite} from './runner.js';
import {defineSuite} from './types.js';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const SLOT_TWO = 'gsk_abcdefghijklmnopqrstuvwxyz012345';
const directories: string[] = [];
const scratch = () => {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-verify-test-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

function everyFile(directory: string): string {
  return readdirSync(directory, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath, entry.name), 'utf8')).join('\n');
}

const leaky = defineSuite({
  id: 'leaky',
  issue: 'PRA-1',
  title: 'A suite whose step tries every way to leak its key',
  steps: [
    {
      id: 'leak',
      kind: 'auto',
      checklist: 'The key never reaches a proof.',
      needs: {secrets: ['TEST_LIVE_KEY'], pools: [{name: 'TEST_POOL_KEY', service: 'test', minSlots: 2}]},
      async run(context) {
        const key = context.secret('TEST_LIVE_KEY');
        const slots = context.pool('TEST_POOL_KEY').slots.map(slot => slot.credential.reveal());
        context.log(`using ${key.reveal()} and ${slots.join(',')}; Authorization: Bearer ${key.reveal()}`);
        context.log(`as JSON ${JSON.stringify({key: key.reveal()})} and sealed ${String(key)}`);
        context.attach('response.json', JSON.stringify({echo: key.reveal(), url: `https://x.test/?k=${encodeURIComponent(key.reveal())}`}));
        context.state.set('leak', key.reveal());
        return {status: 'pass', summary: `summary with ${key.reveal()}`};
      },
    },
    {
      id: 'throws',
      kind: 'auto',
      checklist: 'Errors are redacted too.',
      needs: {secrets: ['TEST_LIVE_KEY']},
      async run(context) {
        throw new Error(`upstream said ${context.state.get('leak')}`);
      },
    },
  ],
});

describe('live runner', () => {
  it('never writes key material into proof.json or evidence, whatever the step does', async () => {
    const directory = scratch();
    const env = {TEST_LIVE_KEY: KEY, TEST_POOL_KEY: KEY.replace('0123', '9999'), TEST_POOL_KEY_2: SLOT_TWO};
    const {proof, path} = await runSuite(leaky, {env, evidence: new Map(), directory});
    expect(proof.steps.map(step => step.status)).toEqual(['pass', 'fail']);
    const written = everyFile(directory);
    expect(written).toContain('[redacted]');
    for (const secret of [KEY, env.TEST_POOL_KEY, SLOT_TWO, encodeURIComponent(KEY)]) expect(written).not.toContain(secret);
    expect(ProofSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).status).toBe('failed');
  });

  it('skips a step with the missing credential named, and never runs it', async () => {
    let ran = false;
    const suite = defineSuite({id: 's', issue: 'PRA-2', title: 'T', steps: [{id: 'a', kind: 'auto', checklist: 'c', needs: {secrets: ['ABSENT_TOKEN']}, run: async () => {
      ran = true;
      return {status: 'pass', summary: ''};
    }}]});
    const {proof} = await runSuite(suite, {env: {}, evidence: new Map(), directory: scratch()});
    expect(ran).toBe(false);
    expect(proof.steps[0]).toMatchObject({status: 'skipped', reason: 'missing credential ABSENT_TOKEN'});
    expect(proof.status).toBe('incomplete');
  });

  it('names the missing pool slot', () => {
    expect(missingNeed({pools: [{name: 'GROQ_API_KEY', service: 'groq', minSlots: 2}]}, {GROQ_API_KEY: 'k'.repeat(20)})).toBe('missing credential GROQ_API_KEY (needs 2 slots, found 1)');
    expect(missingNeed({config: ['URL']}, {URL: ' '})).toBe('missing credential URL');
  });

  it('fails a step that reads an undeclared secret', async () => {
    const suite = defineSuite({id: 's', issue: 'PRA-2', title: 'T', steps: [{id: 'a', kind: 'auto', checklist: 'c', needs: {}, run: async context => ({status: 'pass', summary: context.secret('OTHER_KEY').reveal()})}]});
    const {proof} = await runSuite(suite, {env: {OTHER_KEY: KEY}, evidence: new Map(), directory: scratch()});
    expect(proof.steps[0]).toMatchObject({status: 'fail', summary: 'step a reads OTHER_KEY without declaring it in needs'});
  });

  it('records manual evidence by hash, and is complete only when every step passed or is attached', async () => {
    const directory = scratch();
    const screenshot = join(scratch(), 'card.png');
    writeFileSync(screenshot, 'png-bytes');
    const manual = (id: string, evidence: 'file' | 'url') => ({id, kind: 'manual' as const, checklist: id, needs: {}, instruction: `do ${id}`, evidence});
    const suite = defineSuite({id: 's', issue: 'PRA-3', title: 'T', steps: [manual('shot', 'file'), manual('link', 'url'), manual('later', 'file')]});
    const pending = await runSuite(suite, {env: {}, evidence: parseEvidence([`shot=${screenshot}`, 'link=https://vercel.com/logs?q=a=b']), directory});
    expect(pending.proof.steps.map(step => step.status)).toEqual(['attached', 'attached', 'pending']);
    expect(pending.proof.steps[0]!.evidence[0]).toEqual({kind: 'file', path: 'evidence/shot-card.png', sha256: createHash('sha256').update('png-bytes').digest('hex'), bytes: 9});
    expect(pending.proof.steps[1]!.evidence[0]).toEqual({kind: 'url', url: 'https://vercel.com/logs?q=a=b'});
    expect(pending.proof.status).toBe('incomplete');
    const done = await runSuite(suite, {env: {}, evidence: parseEvidence([`shot=${screenshot}`, 'link=https://x.test/', `later=${screenshot}`]), directory: scratch()});
    expect(done.proof.status).toBe('complete');
  });

  it('rejects malformed --evidence and URLs carrying credentials', async () => {
    expect(() => parseEvidence(['nostep'])).toThrow(/expects <step>=/);
    const suite = defineSuite({id: 's', issue: 'PRA-3', title: 'T', steps: [{id: 'link', kind: 'manual', checklist: 'c', needs: {}, instruction: 'i', evidence: 'url'}]});
    await expect(runSuite(suite, {env: {}, evidence: parseEvidence(['link=https://user:pw@x.test/']), directory: scratch()})).rejects.toThrow(/must not carry credentials/);
  });
});

describe('evidence redaction and partial runs', () => {
  const manual = (id: string) => ({id, kind: 'manual' as const, checklist: id, needs: {}, instruction: 'i', evidence: 'file' as const});

  it('redacts text evidence, manual or attached as bytes, before writing and hashing it', async () => {
    const directory = scratch();
    const log = join(scratch(), 'vercel.log');
    writeFileSync(log, `credential.cooldown slot=1 auth=Bearer ${KEY}\n`);
    const suite = defineSuite({id: 's', issue: 'PRA-4', title: 'T', steps: [
      manual('logs'),
      {id: 'bytes', kind: 'auto', checklist: 'c', needs: {secrets: ['TEST_LIVE_KEY']}, run: async context => {
        context.attach('dump.txt', new TextEncoder().encode(`raw ${context.secret('TEST_LIVE_KEY').reveal()}`));
        return {status: 'pass', summary: 'ok'};
      }},
    ]});
    const {proof} = await runSuite(suite, {env: {TEST_LIVE_KEY: KEY}, evidence: parseEvidence([`logs=${log}`]), directory});
    expect(everyFile(directory)).not.toContain(KEY);
    const stored = readFileSync(join(directory, 'evidence/logs-vercel.log'));
    expect(proof.steps[0]!.evidence[0]).toMatchObject({sha256: createHash('sha256').update(stored).digest('hex')});
  });

  it('keeps screenshots as they are and refuses other binary evidence it cannot redact', async () => {
    const png = join(scratch(), 'card.png');
    const blob = join(scratch(), 'dump.bin');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
    writeFileSync(blob, Buffer.from([0, 0xff, 0xfe, 0x00]));
    const suite = defineSuite({id: 's', issue: 'PRA-4', title: 'T', steps: [manual('shot')]});
    const kept = await runSuite(suite, {env: {}, evidence: parseEvidence([`shot=${png}`]), directory: scratch()});
    expect(kept.proof.steps[0]).toMatchObject({status: 'attached', evidence: [{bytes: 6}]});
    await expect(runSuite(suite, {env: {}, evidence: parseEvidence([`shot=${blob}`]), directory: scratch()})).rejects.toThrow(/cannot be redacted/);
  });

  it('records unselected steps as skipped, so an --only run is never complete', async () => {
    const png = join(scratch(), 'a.png');
    writeFileSync(png, 'x');
    const suite = defineSuite({id: 's', issue: 'PRA-4', title: 'T', steps: [manual('a'), manual('b')]});
    const {proof} = await runSuite(suite, {env: {}, evidence: parseEvidence([`a=${png}`]), only: ['a'], directory: scratch()});
    expect(proof.steps.map(step => [step.id, step.status, step.reason])).toEqual([['a', 'attached', undefined], ['b', 'skipped', 'not selected (--only)']]);
    expect(proof.status).toBe('incomplete');
  });
});

describe('redactor', () => {
  it('redacts declared values in raw, JSON and URL forms, plus known key shapes and bearer tokens', () => {
    const redactor = new Redactor().add(SealedSecret.of('s3cr3t"value/with+chars')).addEnv({SOME_API_KEY: 'plain-env-secret', PUBLIC_URL: 'https://example.com'});
    const text = [
      's3cr3t"value/with+chars',
      JSON.stringify('s3cr3t"value/with+chars'),
      encodeURIComponent('s3cr3t"value/with+chars'),
      'plain-env-secret',
      'Bearer abc.def.ghi-123456',
      'sk-or-v1-feedfacefeedfacefeedface',
      'https://example.com',
    ].join('\n');
    expect(redactor.apply(text).split('\n')).toEqual(['[redacted]', '"[redacted]"', '[redacted]', '[redacted]', 'Bearer [redacted]', '[redacted]', 'https://example.com']);
  });
});

describe('live suites', () => {
  it.each(['credential-pool', 'openrouter'])('%s skips every auto step and leaves manual steps pending without credentials', async id => {
    const suite = await loadSuite(id);
    expect(suite.steps.every(step => step.checklist.length > 0)).toBe(true);
    const {proof} = await runSuite(suite, {env: {}, evidence: new Map(), directory: scratch()});
    for (const step of proof.steps) expect(step.status).toBe(step.kind === 'auto' ? 'skipped' : 'pending');
    expect(proof.status).toBe('incomplete');
  });
});
