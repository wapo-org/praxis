import { spawn } from 'node:child_process';
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, loadEnv, envArg, validate, apiKeys, safeBuildEnv } from './deploy-config.mjs';
import {
  assertSafeUpload,
  listFiles,
  stageApi,
  withPrivateFile,
  writeUploadList,
} from './deploy-stage.mjs';
/** Pinned: the CLI runs with deployment credentials, so it must never float to a newly published release. */
export const VERCEL_CLI = 'vercel@65.9.0';
export function deploymentPlan(env) {
  const vercel = ['npx', '--yes', VERCEL_CLI],
    convex = ['npx', '--no-install', 'convex'];
  return [
    {
      name: 'Convex deploy',
      cwd: root,
      args: [...convex, 'deploy', '--yes'],
      remote: true,
      tool: 'convex',
    },
    {
      name: 'Convex server credential',
      cwd: root,
      args: [
        ...convex,
        'env',
        'set',
        'PRAXIS_CONVEX_SERVER_TOKEN',
        '--from-file',
        '<private-input>',
      ],
      remote: true,
      inputKey: 'PRAXIS_CONVEX_SERVER_TOKEN',
      fileInput: true,
      tool: 'convex',
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
        cwd: join(root, '.deploy/api'),
        args: [...vercel, 'env', 'add', key, 'production', '--force', '--yes'],
        remote: true,
        tool: 'vercel',
        inputKey: key,
      })),
    {
      name: 'Local API build',
      cwd: root,
      args: ['npm', 'run', 'build', '-w', '@praxis/api'],
      remote: false,
    },
    {
      name: 'API deploy (staged allowlist; project root cloud/apps/api, build from vercel.json)',
      cwd: join(root, '.deploy/api'),
      args: [...vercel, 'deploy', '--prod', '--yes'],
      remote: true,
      tool: 'vercel',
      api: true,
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
      args: [...vercel, 'deploy', '--prebuilt', '--prod', '--yes'],
      remote: true,
      tool: 'vercel',
      web: true,
    },
  ];
}
export function maskCommand(step) {
  return step.args.join(' ') + (step.inputKey ? ' < <masked private input>' : '');
}
/** Credentials travel only in the environment of the one tool that needs them, never in argv. */
export function stepEnv(step, env, api) {
  const base = safeBuildEnv(api);
  if (step.tool === 'convex') return { ...base, CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY };
  if (step.tool === 'vercel')
    return {
      ...base,
      VERCEL_TOKEN: env.VERCEL_TOKEN,
      VERCEL_ORG_ID: env.VERCEL_ORG_ID,
      VERCEL_PROJECT_ID: step.web ? env.VERCEL_WEB_PROJECT_ID : env.VERCEL_API_PROJECT_ID,
    };
  return base;
}
/** Stages and checks an upload; prints a per-directory summary and writes the full list. */
async function checkUpload(label, stage, env) {
  const files = await listFiles(stage);
  await assertSafeUpload(
    stage,
    files,
    Object.entries(env)
      .filter(([k]) => /TOKEN|KEY|SECRET/.test(k))
      .map(([, v]) => v),
  );
  const list = await writeUploadList(stage, files);
  const groups = {};
  for (const f of files) {
    const top = f
      .split('/')
      .slice(0, f.startsWith('cloud/') ? 3 : 1)
      .join('/');
    groups[top] = (groups[top] ?? 0) + 1;
  }
  console.log(
    `${label} upload: ${files.length} files, no secret files (full list: ${relative(root, list)})`,
  );
  for (const [dir, n] of Object.entries(groups)) console.log(`  ${dir}: ${n}`);
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
  await rm(join(stage, '.vercel/output/static'), {
    recursive: true,
    force: true,
  });
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
    JSON.stringify({
      orgId: env.VERCEL_ORG_ID,
      projectId: env.VERCEL_WEB_PROJECT_ID,
    }),
  );
}
export async function deploy(args = process.argv.slice(2), runner = execute, paths = {}) {
  const deployDir = paths.deployDir ?? join(root, '.deploy'),
    webDist = paths.webDist ?? join(root, 'apps/web/dist');
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
  // Staging is local and runs in dry mode too, so the rehearsal checks exactly what would upload.
  await checkUpload('API', await stageApi(join(deployDir, 'api'), paths.source), env);
  for (const step of deploymentPlan(env)) {
    console.log(`${dry && step.remote ? 'SKIP remote' : 'RUN'} ${step.name}: ${maskCommand(step)}`);
    if (step.web && step.remote) {
      await stageWeb(env, join(deployDir, 'web'), webDist);
      await checkUpload('Web', join(deployDir, 'web'), env);
    }
    if (dry && step.remote) continue;
    if (!step.remote) {
      await runner(step, safeBuildEnv(api));
      continue;
    }
    const childEnv = stepEnv(step, env, api);
    if (step.fileInput)
      await withPrivateFile(env[step.inputKey], (file) =>
        runner(
          {
            ...step,
            args: step.args.map((a) => (a === '<private-input>' ? file : a)),
          },
          childEnv,
        ),
      );
    else await runner(step, childEnv, step.inputKey ? env[step.inputKey] : undefined);
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
