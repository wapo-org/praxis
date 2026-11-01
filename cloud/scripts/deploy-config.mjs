import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const required = [
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_API_PROJECT_ID',
  'VERCEL_WEB_PROJECT_ID',
  'CONVEX_DEPLOY_KEY',
  'PRAXIS_API_URL',
  'PRAXIS_WEB_ORIGINS',
  'CONVEX_URL',
  'PRAXIS_CONVEX_SERVER_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
  'PRAXIS_ENCRYPTION_KEYS',
  'BETTER_AUTH_SECRET',
];
export const apiKeys = required
  .filter((k) => !k.startsWith('VERCEL_') && k !== 'CONVEX_DEPLOY_KEY')
  .concat([
    'PRAXIS_COOKIE_SAMESITE',
    'PRAXIS_RUN_BUDGET_MS',
    'PRAXIS_SYNC_STRATEGY',
    'GROQ_API_KEY',
  ]);
export async function loadEnv(file = new URL('../.env.deploy', import.meta.url)) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw Error('Cannot read deploy env file');
  }
  const env = {};
  for (const [i, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) throw Error(`Invalid env syntax at line ${i + 1}`);
    let value = m[2];
    if (/^['"]/.test(value)) {
      if (value.at(-1) !== value[0]) throw Error(`Invalid quoting at line ${i + 1}`);
      value = value.slice(1, -1);
    } else value = value.replace(/\s+#.*$/, '');
    if (Object.hasOwn(env, m[1])) throw Error(`Duplicate variable ${m[1]}`);
    env[m[1]] = value;
  }
  return env;
}
export function validate(env) {
  const errors = required.filter((k) => !env[k]).map((k) => `${k}: missing`);
  const check = (key, fn, reason) => {
    if (env[key]) {
      let valid = false;
      try {
        valid = fn(env[key]);
      } catch {}
      if (!valid) errors.push(`${key}: ${reason}`);
    }
  };
  const origin = (value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        u.origin === value.replace(/\/$/, '')
      );
    } catch {
      return false;
    }
  };
  for (const k of ['PRAXIS_API_URL', 'CONVEX_URL', 'UPSTASH_REDIS_REST_URL'])
    check(k, origin, 'must be an HTTPS origin');
  check(
    'PRAXIS_WEB_ORIGINS',
    (v) => v.split(',').every((x) => origin(x.trim())),
    'must list HTTPS web origins',
  );
  check(
    'CONVEX_URL',
    (v) => new URL(v).hostname.endsWith('.convex.cloud'),
    'must be a Convex cloud URL',
  );
  check(
    'UPSTASH_REDIS_REST_URL',
    (v) => new URL(v).hostname.endsWith('.upstash.io'),
    'must be an Upstash REST URL',
  );
  for (const k of ['BETTER_AUTH_SECRET', 'PRAXIS_CONVEX_SERVER_TOKEN'])
    check(
      k,
      (v) => v.length >= 32 && !/\s/.test(v),
      'must have at least 32 non-whitespace characters',
    );
  for (const k of [
    'VERCEL_TOKEN',
    'UPSTASH_REDIS_REST_TOKEN',
    'QSTASH_TOKEN',
    'QSTASH_CURRENT_SIGNING_KEY',
    'QSTASH_NEXT_SIGNING_KEY',
    'CONVEX_DEPLOY_KEY',
  ])
    check(k, (v) => v.length >= 16 && !/\s/.test(v), 'invalid token format');
  for (const k of ['VERCEL_API_PROJECT_ID', 'VERCEL_WEB_PROJECT_ID'])
    check(k, (v) => /^prj_[\w-]+$/.test(v), 'must be a prj_ project ID');
  check('VERCEL_ORG_ID', (v) => /^(team|user)_[\w-]+$/.test(v), 'must be a team_ or user_ ID');
  check(
    'PRAXIS_ENCRYPTION_KEYS',
    (v) =>
      v
        .split(',')
        .every(
          (x) =>
            /^[A-Za-z0-9+/]{43}=$/.test(x.trim()) && Buffer.from(x.trim(), 'base64').length === 32,
        ),
    'must list base64 32-byte keys, current first',
  );
  check(
    'PRAXIS_COOKIE_SAMESITE',
    (v) => ['lax', 'strict', 'none'].includes(v),
    'must be lax, strict, or none',
  );
  check(
    'PRAXIS_SYNC_STRATEGY',
    (v) => ['cursor', 'merkle'].includes(v),
    'must be cursor or merkle',
  );
  check(
    'PRAXIS_RUN_BUDGET_MS',
    (v) => /^\d+$/.test(v) && Number(v) >= 10000 && Number(v) <= 270000,
    'must be 10000..270000 ms',
  );
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY'])
    check(
      k,
      (v) => /^sk-[^\s]{12,}$/.test(v) || /^gsk_[^\s]{12,}$/.test(v),
      'invalid API key format',
    );
  if (env.PRAXIS_LOCAL_SMOKE || env.NODE_ENV === 'development')
    errors.push('Production forbids local smoke/development mode');
  return errors;
}
export function envArg(args) {
  const i = args.indexOf('--env');
  if (i >= 0 && !args[i + 1]) throw Error('--env needs a file');
  return i >= 0 ? args[i + 1] : undefined;
}
export function safeBuildEnv(apiUrl) {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C.UTF-8',
    CI: '1',
    NODE_ENV: 'production',
    VITE_API_BASE_URL: apiUrl,
  };
}
