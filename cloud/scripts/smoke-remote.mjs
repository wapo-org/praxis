import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { loadEnv, envArg } from './deploy-config.mjs';
export function assertWorkerBypassesApi(source, web) {
  const result = vm.runInNewContext(
    `
 let handler;const self={location:{origin:${JSON.stringify(web)}},addEventListener:(name,fn)=>{if(name==='fetch')handler=fn;}};
 class URL{constructor(value){const match=/^(https?:\\/\\/[^/]+)([^?#]*)/.exec(value);this.origin=match?.[1];this.pathname=match?.[2]||'/';}}
 ${source}
 if(typeof handler!=='function')throw Error('Missing worker handler');
 JSON.stringify(['/v1/bootstrap','/v1/chats','/v1/file.js','/health'].map(path=>{let intercepted=false;handler({request:{method:'GET',url:self.location.origin+path,mode:'navigate'},respondWith:()=>intercepted=true});return intercepted;}));
 `,
    Object.create(null),
    { timeout: 1000, contextCodeGeneration: { strings: false, wasm: false } },
  );
  assert.deepEqual(
    JSON.parse(result),
    [false, false, false, false],
    'Service worker intercepted an API/health request',
  );
}
export async function smoke(args = process.argv.slice(2), fetcher = fetch) {
  const urls = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--env');
  if (urls.length !== 2)
    throw Error('Usage: smoke-remote.mjs <apiUrl> <webUrl> [--dry-run] [--with-llm] [--env file]');
  const [api, web] = urls.map((v) => {
    const u = new URL(v);
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.origin !== v.replace(/\/$/, '')
    )
      throw Error('Use bare HTTP(S) origins');
    return u.origin;
  });
  const dry = args.includes('--dry-run'),
    checks = [],
    skipped = [];
  let token = '',
    created = false,
    local = false;
  const email = `praxis-smoke-${randomUUID()}@example.com`,
    password = randomBytes(24).toString('base64url');
  const call = async (path, method = 'GET', body, auth = true) => {
    const res = await fetcher(api + path, {
      method,
      headers: {
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw Error(`${method} ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const health = await call('/health');
  assert.equal(health.ok, true);
  checks.push('health');
  const shell = await fetcher(web, { signal: AbortSignal.timeout(30000) });
  assert.ok(shell.ok);
  const html = await shell.text();
  assert.match(html, /id=["']root["']/);
  checks.push('app shell');
  const sw = await fetcher(web + '/sw.js', { signal: AbortSignal.timeout(30000) });
  assert.ok(sw.ok);
  assertWorkerBypassesApi(await sw.text(), web);
  checks.push('service worker bypasses /v1 and /health');
  local =
    health.mode === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname);
  if (dry && !local) {
    skipped.push('Hosted mutations/auth/LLM/SSE/upload: dry run never creates a hosted account');
    return { checks, skipped };
  }
  if (!local && new URL(api).protocol !== 'https:') throw Error('Hosted smoke requires HTTPS');
  let failure;
  try {
    if (local) {
      for (const op of ['sign-up', 'sign-in']) {
        const response = await fetcher(api + `/v1/auth/${op}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'auth.input', email, password, name: 'Smoke' }),
        });
        assert.equal(response.status, 503);
      }
      skipped.push(
        'dev:local email sign-up/sign-in are unconfigured (503); tested disposable dev session instead',
      );
      const session = await call(
        '/v1/auth/dev',
        'POST',
        { type: 'auth.dev', userId: `smoke-${randomUUID()}` },
        false,
      );
      token = session.bearerToken;
      created = true;
      await call('/v1/auth/sign-out', 'POST', {});
      const expired = await fetcher(api + '/v1/bootstrap', {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(expired.status, 401);
      const fresh = await call(
        '/v1/auth/dev',
        'POST',
        { type: 'auth.dev', userId: session.user.id },
        false,
      );
      token = fresh.bearerToken;
      checks.push('local session/sign-out/revocation');
    } else {
      // Assume the account may exist as soon as sign-up is attempted: cleanup then signs in to check.
      created = true;
      const response = await fetcher(api + '/v1/auth/sign-up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'auth.input', email, password, name: 'Deployment smoke' }),
      });
      assert.ok(response.ok, 'Sign-up failed');
      token = (await response.json()).bearerToken;
      await call('/v1/auth/sign-out', 'POST', {});
      token = ''; // revoked; cleanup must not reuse it
      token = (
        await call('/v1/auth/sign-in', 'POST', { type: 'auth.input', email, password }, false)
      ).bearerToken;
      checks.push('sign-up/sign-out/sign-in');
    }
    const bootstrap = await call('/v1/bootstrap');
    assert.ok(bootstrap.user.id);
    checks.push('authenticated bootstrap');
    const chat = await call('/v1/chats', 'POST', {
      type: 'chat.input',
      title: 'Deploy smoke',
      mode: 'build',
      pinned: false,
      disabledConnectorIds: [],
    });
    checks.push('chat');
    const bytes = Buffer.from('Praxis smoke upload\n'),
      input = { name: 'smoke.txt', mediaType: 'text/plain', size: bytes.length, chatId: chat.id };
    const ticket = await call('/v1/uploads', 'POST', { type: 'upload.request', ...input });
    const target = new URL(ticket.uploadUrl, api);
    assert.ok(target.protocol === 'https:' || (local && target.origin === api));
    const upload = await fetcher(target, {
      method: ticket.method ?? 'PUT',
      headers: {
        'content-type': input.mediaType,
        ...(target.origin === api ? { authorization: `Bearer ${token}` } : {}),
      },
      body: bytes,
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(upload.ok);
    const receipt = await upload.json();
    const attachment = await call('/v1/uploads/complete', 'POST', {
      type: 'upload.complete',
      ...input,
      storageId: receipt.storageId,
    });
    const download = await fetcher(
      api + `/v1/uploads/${encodeURIComponent(attachment.id)}/download`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) },
    );
    assert.ok(download.ok);
    assert.equal(await download.text(), bytes.toString());
    checks.push('upload/download round trip');
    let runInput;
    if (local) {
      runInput = { script: 'long' };
      skipped.push(
        'Real LLM call skipped in local dry run; scripted local run verifies SSE transport only',
      );
    } else if (args.includes('--with-llm')) {
      const env = await loadEnv(envArg(args));
      if (!env.SMOKE_LLM_KEY || !env.SMOKE_LLM_MODEL || !env.SMOKE_LLM_BASE_URL)
        throw Error(
          '--with-llm needs SMOKE_LLM_KEY, SMOKE_LLM_MODEL, SMOKE_LLM_BASE_URL in deploy env',
        );
      const provider = await call('/v1/providers', 'POST', {
        type: 'provider.input',
        name: 'Smoke provider',
        flavor: env.SMOKE_LLM_FLAVOR ?? 'openAIChat',
        baseUrl: env.SMOKE_LLM_BASE_URL,
        apiKey: env.SMOKE_LLM_KEY,
      });
      await call('/v1/consents', 'POST', {
        type: 'consent',
        host: new URL(env.SMOKE_LLM_BASE_URL).hostname,
        allowed: true,
      });
      await call(`/v1/providers/${provider.id}/refresh-models`, 'POST', { type: 'models.refresh' });
      runInput = { providerId: provider.id, modelId: env.SMOKE_LLM_MODEL };
    } else
      skipped.push(
        'LLM and SSE checks skipped: no explicit --with-llm configuration; production has no scripted fallback',
      );
    if (runInput) {
      const run = await call('/v1/runs', 'POST', {
        type: 'run.start',
        chatId: chat.id,
        text: 'Reply briefly with ok.',
        ...runInput,
      });
      const stream = await fetcher(api + `/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60000),
      });
      assert.ok(stream.ok);
      const reader = stream.body.getReader();
      let initial = '',
        id = 0;
      const decoder = new TextDecoder();
      while (!id) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE ended before an event');
        initial += decoder.decode(chunk.value, { stream: true });
        id = Number(initial.match(/(?:^|\n)id:\s*(\d+)\s*\n/)?.[1] ?? 0);
      }
      await reader.cancel();
      const resume = await fetcher(api + `/v1/runs/${run.id}/events`, {
        headers: { authorization: `Bearer ${token}`, 'Last-Event-ID': String(id) },
        signal: AbortSignal.timeout(60000),
      });
      assert.ok(resume.ok);
      const events = await resume.text();
      const ids = [...events.matchAll(/(?:^|\n)id:\s*(\d+)\s*\n/g)].map((m) => Number(m[1]));
      assert.ok(ids.every((n) => n > id));
      const snapshot = await call(`/v1/runs/${run.id}/snapshot`);
      assert.equal(snapshot.run.status, 'completed');
      checks.push('SSE disconnect/resume and finished snapshot');
    }
  } catch (e) {
    failure = e;
  }
  if (created) {
    try {
      await cleanup();
      checks.push('account/data cleanup and session revocation');
    } catch (e) {
      // Report the original failure; the cleanup error is attached, never substituted.
      if (failure)
        failure.message += ` (cleanup also failed: ${e.message}; delete ${email} manually)`;
      else failure = e;
    }
  }
  if (failure) throw failure;
  return { checks, skipped };

  /** Deletes the throwaway user with a credential that is still valid, re-authenticating if needed. */
  async function cleanup() {
    const signIn = async () => {
      token = '';
      token = (
        await call('/v1/auth/sign-in', 'POST', { type: 'auth.input', email, password }, false)
      ).bearerToken;
    };
    if (!token && !local) await signIn();
    const remove = () =>
      call('/v1/account', 'DELETE', { type: 'account.delete', ...(local ? {} : { password }) });
    try {
      await remove();
    } catch (e) {
      if (local || !/HTTP 401$/.test(e.message)) throw e;
      await signIn();
      await remove();
    }
    const dead = await fetcher(api + '/v1/bootstrap', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(dead.status, 401);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  smoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      console.log('PASS: smoke (listed skips are not successes)');
    })
    .catch((e) => {
      console.error(`FAIL: ${e.message}`);
      process.exitCode = 1;
    });
