import {describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {HOSTED_API_URL, type AutoStep, type StepContext} from '@praxis/verify';
import suite from './openrouter.js';

// `.invalid` never resolves, so even a regression cannot reach a real deployment from this test.
const TARGET = 'https://api.smoke.invalid';
const PASSWORD = 'adapter-fixture-password-never-printed';
const EMAIL = 'adapter-fixture@smoke.invalid';
const SECRETS: Record<string, string> = {SMOKE_FIXTURE_EMAIL: EMAIL, SMOKE_FIXTURE_PASSWORD: PASSWORD};
const CONFIG: Record<string, string> = {
  [HOSTED_API_URL]: TARGET,
  PRAXIS_LIVE_WEB_URL: 'https://web.smoke.invalid',
  SMOKE_API_ORIGIN: TARGET,
  SMOKE_CONVEX_URL: 'https://fixture.smoke.invalid',
  SMOKE_FIXTURE_USER_ID: 'fixture-user',
};

function smokeStep(): AutoStep {
  const step = suite.steps.find(candidate => candidate.id === 'smoke-remote');
  if (step?.kind !== 'auto') throw new Error('smoke-remote must be an auto step');
  return step;
}

function stepContext(config: Record<string, string>, secrets = SECRETS) {
  const attached = new Map<string, string>();
  const read = (values: Record<string, string>, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`undeclared ${name}`);
    return value;
  };
  const context: StepContext = {
    secret: name => SealedSecret.of(read(secrets, name)),
    config: name => read(config, name),
    pool: () => {
      throw new Error('smoke-remote uses no pools');
    },
    log: () => {},
    attach: (name, content) => {
      attached.set(name, String(content));
    },
    state: new Map(),
  };
  return {context, attached};
}

describe('smoke-remote live step', () => {
  it('declares SMOKE_API_ORIGIN as its own fixture config, separate from the target URL', () => {
    const {needs} = smokeStep();
    expect(needs.config).toEqual(expect.arrayContaining([HOSTED_API_URL, 'SMOKE_API_ORIGIN', 'SMOKE_CONVEX_URL']));
    expect(needs.secrets).toEqual(['SMOKE_FIXTURE_EMAIL', 'SMOKE_FIXTURE_PASSWORD']);
  });

  it('fails a mistaken target before any request and never prints fixture credentials', async () => {
    const {context, attached} = stepContext({...CONFIG, SMOKE_API_ORIGIN: 'https://other-api.smoke.invalid'});
    expect(await smokeStep().run(context)).toEqual({status: 'fail', summary: 'smoke-remote exited 1'});
    const log = attached.get('smoke-remote.log') ?? '';
    expect(log).toContain('FAIL: SMOKE_API_ORIGIN does not name this API');
    for (const secret of [PASSWORD, EMAIL]) expect(log).not.toContain(secret);
  });

  it('rejects a malformed bound origin without rendering it', async () => {
    const {context, attached} = stepContext({...CONFIG, SMOKE_API_ORIGIN: 'https://user:adapter-userinfo@api.smoke.invalid/path'});
    expect((await smokeStep().run(context)).status).toBe('fail');
    const log = attached.get('smoke-remote.log') ?? '';
    expect(log).toContain('FAIL: SMOKE_API_ORIGIN must be a bare HTTPS origin');
    expect(log).not.toContain('adapter-userinfo');
  });

  it('refuses a multi-line binding before writing the env file, without echoing it', async () => {
    const {context} = stepContext(CONFIG, {...SECRETS, SMOKE_FIXTURE_PASSWORD: `${PASSWORD}\nSMOKE_API_ORIGIN=https://evil.invalid`});
    await expect(smokeStep().run(context)).rejects.toThrow(/^SMOKE_FIXTURE_PASSWORD must be a single line$/);
  });
});
