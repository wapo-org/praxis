export const API = 'https://api.test';
export const WEB = 'https://web.test';
export const CONVEX = 'https://fixture-smoke.convex.cloud';
export const STORAGE = 'https://storage.test';
export const FIXTURE_USER = 'fixture-user';
export const EMAIL = 'smoke-fixture@example.test';
export const PASSWORD = 'fixture-password-never-printed';
export const SIGN_IN = 'auth:signInWithEmailPassword';
export const SIGN_OUT = 'auth:signOut';
export const REFRESH = 'auth:refreshSession';
/** Server error bodies carry this marker; smoke must report stages, never echo server text. */
export const LEAK = `server-echo-${PASSWORD}`;
export const BINDINGS: Record<string, string> = {
  SMOKE_API_ORIGIN: API,
  SMOKE_CONVEX_URL: CONVEX,
  SMOKE_FIXTURE_EMAIL: EMAIL,
  SMOKE_FIXTURE_PASSWORD: PASSWORD,
  SMOKE_FIXTURE_USER_ID: FIXTURE_USER,
};

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ConvexCall = { path: string; args: Record<string, unknown>; auth: string | null };
export type SignInReply = { status: 'complete'; userId?: string } | { status: 'error'; error: string };
export type HostedOptions = {
  signIn?: SignInReply;
  uploadStatus?: number;
  chatDeleteStatus?: number;
  expireFirstDelete?: boolean;
  modelKey?: boolean;
  /** Session numbers (1-based sign-in order) whose revocation request fails, whose check fails, or that stay live. */
  signOutFail?: number[];
  checkFail?: number[];
  signOutIgnored?: number[];
};

export function shell(path: string) {
  if (path === '/sw.js') return new Response("self.addEventListener('fetch',e=>{})");
  return new Response('<div id="root"></div>');
}

/** In-memory API plus the official Convex HTTP function contract; nothing leaves the process. */
export function hostedFixture(options: HostedOptions = {}) {
  const requests: string[] = [];
  const convexCalls: ConvexCall[] = [];
  // Access tokens the API accepts, and live sessions by refresh token: an expired access token leaves its session live.
  const accepted = new Set<string>();
  const live = new Map<string, { access: string; session: number }>();
  let signIns = 0;
  let deletes = 0;

  function convex(url: URL, init?: RequestInit) {
    const body = JSON.parse(String(init?.body)) as { path: string; args: [Record<string, unknown>] };
    const auth = new Headers(init?.headers).get('authorization');
    convexCalls.push({ path: body.path, args: body.args[0], auth });
    const reply = (value: unknown) => Response.json({ status: 'success', value, logLines: [] });
    const failed = () => new Response(LEAK, { status: 500 });
    const refreshToken = String(body.args[0].refreshToken);
    const session = Number(refreshToken.match(/^fixture-refresh-(\d+)/)?.[1]);
    if (url.pathname === '/api/mutation' && body.path === SIGN_IN) {
      const signIn = options.signIn ?? { status: 'complete' };
      if (signIn.status === 'error') return reply({ status: 'error', userError: { error: signIn.error } });
      signIns++;
      const tokens = {
        accessToken: `fixture-access-${signIns}`,
        refreshToken: `fixture-refresh-${signIns}`,
        refreshTokenExpiresAt: 1,
        userId: signIn.userId ?? FIXTURE_USER,
      };
      accepted.add(tokens.accessToken);
      live.set(tokens.refreshToken, { access: tokens.accessToken, session: signIns });
      return reply({ status: 'complete', tokens });
    }
    if (url.pathname === '/api/mutation' && body.path === SIGN_OUT) {
      if (options.signOutFail?.includes(session)) return failed();
      if (!options.signOutIgnored?.includes(session)) {
        accepted.delete(live.get(refreshToken)?.access ?? '');
        live.delete(refreshToken);
      }
      return reply(null);
    }
    if (url.pathname === '/api/mutation' && body.path === REFRESH) {
      if (options.checkFail?.includes(session)) return failed();
      const current = live.get(refreshToken);
      if (!current) return reply({ kind: 'noSession' });
      const rotated = `${refreshToken}-rotated`;
      live.delete(refreshToken);
      live.set(rotated, current);
      return reply({ kind: 'rotated', tokens: { accessToken: current.access, refreshToken: rotated, refreshTokenExpiresAt: 1, userId: FIXTURE_USER } });
    }
    return Response.json({ status: 'error', errorMessage: 'unexpected function' }, { status: 560 });
  }

  function api(url: URL, method: string, init?: RequestInit) {
    const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
    const route = `${method} ${url.pathname}`;
    if (route === 'GET /health') return Response.json({ ok: true, mode: 'production' });
    if (!accepted.has(token)) return Response.json({}, { status: 401 });
    if (route === 'GET /v1/bootstrap') {
      return Response.json({ user: { id: FIXTURE_USER }, ...(options.modelKey ? { modelKey: { maskedKey: '••••' } } : {}) });
    }
    if (route === 'POST /v1/chats') return Response.json({ id: 'smoke-chat' });
    if (route === 'POST /v1/uploads') {
      return Response.json({ uploadUrl: `${STORAGE}/put`, method: 'PUT' }, { status: options.uploadStatus ?? 200 });
    }
    if (route === 'POST /v1/uploads/complete') return Response.json({ id: 'smoke-attachment' });
    if (route === 'GET /v1/uploads/smoke-attachment/download') return new Response('Praxis smoke upload\n');
    if (method === 'DELETE' && options.expireFirstDelete && deletes++ === 0) {
      accepted.delete(token);
      return Response.json({}, { status: 401 });
    }
    if (route === 'DELETE /v1/uploads/smoke-attachment') return Response.json({ type: 'ok' });
    if (route === 'DELETE /v1/chats/smoke-chat') {
      return Response.json({ type: 'ok' }, { status: options.chatDeleteStatus ?? 200 });
    }
    if (route === 'POST /v1/runs') return Response.json({ id: 'smoke-run' });
    if (route === 'GET /v1/runs/smoke-run/events') {
      const resumed = new Headers(init?.headers).get('last-event-id') === '1';
      return new Response(resumed ? 'id: 2\ndata: {}\n\n' : 'id: 1\ndata: {}\n\n');
    }
    if (route === 'GET /v1/runs/smoke-run/snapshot') return Response.json({ run: { status: 'completed' } });
    return Response.json({}, { status: 404 });
  }

  const fetcher: Fetcher = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.origin === CONVEX) return convex(url, init);
    requests.push(`${method} ${url.origin === API ? url.pathname : url.href}`);
    if (url.origin === WEB) return shell(url.pathname);
    if (url.origin === STORAGE) return Response.json({ storageId: 'smoke-storage' });
    return api(url, method, init);
  };
  const calls = () => convexCalls.map((call) => call.path);
  const liveSessions = () => [...live.keys()];
  return { fetcher, requests, convexCalls, calls, liveSessions };
}
