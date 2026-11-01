import { spawn } from 'node:child_process';
import { mkdir, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, loadEnv, envArg, validate, apiKeys, safeBuildEnv } from './deploy-config.mjs';
export function deploymentPlan(env) {
  const token = env.VERCEL_TOKEN ?? '<VERCEL_TOKEN>',
    cwd = dirname(root.replace(/\/$/, ''));
  const vercel = ['npx', '--yes', 'vercel'];
  return [
    { name: 'Convex deploy', cwd: root, args: ['npx', 'convex', 'deploy', '--yes'], remote: true },
    {
      name: 'Convex server credential',
      cwd: root,
      args: [
        'npx',
        'convex',
        'env',
        'set',
        'PRAXIS_CONVEX_SERVER_TOKEN',
        '--from-file',
        '<private-input>',
      ],
      remote: true,
      inputKey: 'PRAXIS_CONVEX_SERVER_TOKEN',
      fileInput: true,
    },
    ...apiKeys
      .filter(
        (k) =>
          env[k] ||
          ![
            'PRAXIS_COOKIE_SAMESITE',
            'PRAXIS_RUN_BUDGET_MS',
            'PRAXIS_SYNC_STRATEGY',
            'GROQ_API_KEY',
          ].includes(k),
      )
      .map((key) => ({
        name: `API env ${key}`,
        cwd,
        args: [...vercel, 'env', 'add', key, 'production', '--force', '--yes', '--token', token],
        remote: true,
        inputKey: key,
      })),
    {
      name: 'Local API build',
      cwd: root,
      args: ['npm', 'run', 'build', '-w', '@praxis/api'],
      remote: false,
    },
    {
      name: 'API deploy (project root cloud/apps/api, build from vercel.json)',
      cwd,
      args: [...vercel, 'deploy', '--prod', '--yes', '--token', token],
      remote: true,
    },
    {
      name: 'Local web build',
      cwd: root,
      args: ['npm', 'run', 'build', '-w', '@praxis/web'],
      remote: false,
      web: true,
    },
    {
      name: 'Static web deploy',
      cwd: join(root, '.deploy/web'),
      args: [...vercel, 'deploy', '--prebuilt', '--prod', '--yes', '--token', token],
      remote: true,
      web: true,
    },
  ];
}
export function maskCommand(step) {
  return (
    step.args.map((v, i) => (step.args[i - 1] === '--token' ? '<masked>' : v)).join(' ') +
    (step.inputKey ? ' < <masked private input>' : '')
  );
}
export function execute(step, env, input) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = step.args,
      child = spawn(cmd, args, {
        cwd: step.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    // CLI output can contain sensitive diagnostics; never forward it. Only report command/status.
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', () => reject(Error(`${step.name}: executable unavailable`)));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(Error(`${step.name}: failed (${code})`)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export async function stageWeb(
  env,
  stage = join(root, '.deploy/web'),
  dist = join(root, 'apps/web/dist'),
) {
  await mkdir(join(stage, '.vercel/output'), { recursive: true });
  await rm(join(stage, '.vercel/output/static'), { recursive: true, force: true });
  await cp(dist, join(stage, '.vercel/output/static'), {
    recursive: true,
    force: true,
  });
  await writeFile(
    join(stage, '.vercel/output/config.json'),
    JSON.stringify({
      version: 3,
      routes: [{ handle: 'filesystem' }, { src: '/(.*)', dest: '/index.html' }],
    }),
  );
  await writeFile(
    join(stage, '.vercel/project.json'),
    JSON.stringify({ orgId: env.VERCEL_ORG_ID, projectId: env.VERCEL_WEB_PROJECT_ID }),
  );
}
export async function deploy(args = process.argv.slice(2), runner = execute) {
  const dry = args.includes('--dry-run');
  const env = await loadEnv(envArg(args));
  const errors = validate(env);
  if (!dry && errors.length) throw Error(`Preflight failed: ${errors.join('; ')}`);
  if (dry) {
    console.log('DRY RUN: no remote CLI or credentialed service will be invoked.');
    for (const e of errors) console.log(e);
  }
  const origin = (value, fallback) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        url.origin === value.replace(/\/$/, '')
        ? url.origin
        : fallback;
    } catch {
      return fallback;
    }
  };
  const api = origin(env.PRAXIS_API_URL, 'https://api.example.invalid'),
    web = origin(env.PRAXIS_WEB_ORIGINS?.split(',')[0].trim(), 'https://web.example.invalid');
  for (const step of deploymentPlan(env)) {
    console.log(`${dry && step.remote ? 'SKIP remote' : 'RUN'} ${step.name}: ${maskCommand(step)}`);
    if (dry && step.remote) continue;
    if (!step.remote) {
      await runner(step, safeBuildEnv(api));
      continue;
    }
    const childEnv = {
      ...safeBuildEnv(api),
      CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY,
      VERCEL_ORG_ID: env.VERCEL_ORG_ID,
      VERCEL_PROJECT_ID: step.web ? env.VERCEL_WEB_PROJECT_ID : env.VERCEL_API_PROJECT_ID,
    };
    if (step.web) await stageWeb(env);
    if (step.fileInput) {
      const dir = await mkdtemp(join(tmpdir(), 'praxis-deploy-'));
      try {
        const file = join(dir, 'input');
        await writeFile(file, env[step.inputKey], { mode: 0o600 });
        await runner(
          { ...step, args: step.args.map((a) => (a === '<private-input>' ? file : a)) },
          childEnv,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } else await runner(step, childEnv, step.inputKey ? env[step.inputKey] : undefined);
  }
  console.log(`${dry ? 'Planned ' : ''}API URL: ${api}`);
  console.log(`${dry ? 'Planned ' : ''}Web URL: ${web}`);
  console.log(
    `OAuth redirect: ${api}/v1/connectors/oauth/callback\nOAuth client metadata: ${api}/v1/oauth/client-metadata.json\nQStash callback: ${api}/internal/continue`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  deploy().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
