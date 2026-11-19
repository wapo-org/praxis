import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import type {StepContext} from '@praxis/verify';
import {z} from 'zod';
import {WORKFLOW_ERRORS} from '../../../convex/workflows/constants.js';
import type {TableReader} from '../convex-typed-rows/commit-purge.js';

const run = promisify(execFile);
const CLOUD_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const RunRow = z.object({
  _id: z.string(), userId: z.string(), workflow: z.object({
    id: z.string().optional(), generation: z.number(), nextTurnIndex: z.number(), status: z.string(),
  }).optional(),
});
const TurnRow = z.object({
  userId: z.string(), runId: z.string(), turnIndex: z.number().int(), done: z.boolean(), status: z.string(),
});
const Owner = z.object({userId: z.string()});

export async function readRuns(reader: TableReader, userId: string) {
  return (await reader('runs')).filter(row => Owner.safeParse(row).data?.userId === userId)
    .map(row => RunRow.parse(row));
}

export async function readTurns(reader: TableReader, userId: string) {
  return (await reader('turns')).filter(row => Owner.safeParse(row).data?.userId === userId)
    .map(row => TurnRow.parse(row));
}

export async function runInternal(context: StepContext, name: 'turns:run' | 'turns:commitStub', args: {
  userId: string; chatId: string; runId: string; generation: number; expectedTurnIndex: number;
}): Promise<unknown> {
  const deployKey = context.secret('CONVEX_DEPLOY_KEY');
  const {stdout} = await run('npx', ['--no-install', 'convex', 'run', name, JSON.stringify(args)], {
    cwd: CLOUD_DIR, env: {...process.env, CONVEX_DEPLOY_KEY: deployKey.reveal()},
  }).catch((error: unknown) => {
    if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      && error.stderr.includes(`ConvexError: ${WORKFLOW_ERRORS.unavailable}`)) {
      throw new Error(WORKFLOW_ERRORS.unavailable);
    }
    throw new Error(`Convex CLI call to ${name} failed`);
  });
  return JSON.parse(stdout);
}
