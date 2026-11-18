import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { loadEnv, envArg } from './deploy-config.mjs';

const signInWithEmailPassword = makeFunctionReference('auth:signInWithEmailPassword');
const signOut = makeFunctionReference('auth:signOut');
const refreshSession = makeFunctionReference('auth:refreshSession');
const REFRESH_LEAD_MS = 10_000;
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
  let token = '', refreshToken = '', accessExpiresAt = 0, cleanupNeeded = false;
  const call = async (path, method = 'GET', body, auth = true) => {
    const res = await fetcher(api + path, {
      method,
      headers: {
        ...(auth && token ? await authHeaders() : {}),
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
  const local =
    health.mode === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname);
  if (dry && !local) {
    skipped.push('Hosted mutations/auth/LLM/SSE/upload: dry run never creates a hosted account');
    return { checks, skipped };
  }
  if (!local && new URL(api).protocol !== 'https:') throw Error('Hosted smoke requires HTTPS');
  const env = local ? {} : await loadEnv(envArg(args));
  const { CONVEX_URL, SMOKE_ACCOUNT_EMAIL: email, SMOKE_ACCOUNT_PASSWORD: password } = env;
  let convex;
  if (!local) {
    if (!CONVEX_URL || !email || !password) {
      throw Error('Hosted smoke needs CONVEX_URL, SMOKE_ACCOUNT_EMAIL and SMOKE_ACCOUNT_PASSWORD for a disposable verified account');
    }
    const url = new URL(CONVEX_URL);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.convex.cloud') || url.href !== url.origin + '/') {
      throw Error('Hosted smoke requires a Convex Cloud HTTPS origin');
    }
    convex = new ConvexHttpClient(url.origin, {
      logger: false,
      fetch: (input, init) => fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(60000) }),
    });
  }
  let failure;
  try {
    if (local) {
      const session = await call(
        '/v1/auth/dev',
        'POST',
        { type: 'auth.dev', userId: `smoke-${randomUUID()}` },
        false,
      );
      token = session.bearerToken;
      cleanupNeeded = true;
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
      cleanupNeeded = true;
      await signIn();
      await convex.mutation(signOut, { refreshToken });
      convex.clearAuth();
      const revoked = await convex.mutation(refreshSession, { refreshToken });
      assert.equal(revoked.kind, 'noSession');
      await signIn();
      checks.push('Convex sign-in/sign-out/revocation');
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
        ...(target.origin === api ? await authHeaders() : {}),
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
      if (!env.SMOKE_OPENROUTER_KEY)
        throw Error('--with-llm needs SMOKE_OPENROUTER_KEY (and optionally SMOKE_OPENROUTER_MODEL) in deploy env');
      // Connects the smoke user's own OpenRouter key; the throwaway account is deleted in `finally`.
      await call('/v1/model-key', 'POST', { method: 'paste', apiKey: env.SMOKE_OPENROUTER_KEY });
      runInput = env.SMOKE_OPENROUTER_MODEL ? { modelId: env.SMOKE_OPENROUTER_MODEL } : {};
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
        headers: await authHeaders(),
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
        headers: { ...await authHeaders(), 'Last-Event-ID': String(id) },
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
  if (cleanupNeeded) {
    try {
      await cleanup();
      checks.push('account/data cleanup and session revocation');
    } catch (e) {
      // Report the original failure; the cleanup error is attached, never substituted.
      if (failure)
        failure.message += ` (cleanup also failed: ${e.message}; check the disposable account)`;
      else failure = e;
    }
  }
  if (failure) throw failure;
  return { checks, skipped };

  async function signIn() {
    token = '';
    convex.clearAuth();
    let result;
    try {
      result = await convex.mutation(signInWithEmailPassword, { email, password });
    } catch (error) {
      throw Error('Convex smoke sign-in request failed', { cause: error });
    }
    if (result.status !== 'complete') throw Error('Convex smoke sign-in requires a verified password account');
    adoptSession(result.tokens);
  }

  function adoptSession(tokens) {
    token = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    accessExpiresAt = exp * 1000;
    convex.setAuth(token);
  }

  async function authHeaders() {
    if (convex && Date.now() + REFRESH_LEAD_MS >= accessExpiresAt) {
      convex.clearAuth();
      const result = await convex.mutation(refreshSession, { refreshToken });
      if (result.kind !== 'rotated') throw Error('Convex smoke session expired');
      adoptSession(result.tokens);
    }
    return { authorization: `Bearer ${token}` };
  }

  async function cleanup() {
    if (!token && !local) await signIn();
    const remove = () =>
      call('/v1/account', 'DELETE', { type: 'account.delete', ...(local ? {} : { password }) });
    try {
      await remove();
    } catch (e) {
      if (local || !e.message.endsWith('HTTP 401')) throw e;
      await signIn();
      await remove();
    }
    const dead = await fetcher(api + '/v1/bootstrap', {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(dead.status, 401);
    if (convex) {
      convex.clearAuth();
      const revoked = await convex.mutation(refreshSession, { refreshToken });
      assert.equal(revoked.kind, 'noSession');
    }
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
