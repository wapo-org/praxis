import {fileURLToPath} from 'node:url';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {z} from 'zod';
import type {StepContext, StepOutcome} from '@praxis/verify';
import {convexCliReader, purgeUntilDone, serverTokenFromDeployment, type Live, type TableReader} from './commit-purge.js';
import {createLiveOwners, newRunId, type LiveOwner} from './owners.js';

const DEPLOYMENT = 'dev:colorless-chinchilla-899';
const CONVEX_ORIGIN = 'https://colorless-chinchilla-899.eu-west-1.convex.cloud';
const DEPLOY_KEY = 'CONVEX_DEPLOY_KEY';
const CONVEX_URL = 'CONVEX_URL';
const CLOUD_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const AccountActive = makeFunctionReference<'query'>('account:active');
const Begin = makeFunctionReference<'mutation'>('account:begin');

export const HOSTED_NEEDS = {config: [CONVEX_URL], secrets: [DEPLOY_KEY]};

export interface HostedFixture {
  live: Live;
  runId: string;
  reader: TableReader;
  owners: [LiveOwner, LiveOwner];
}

type FixtureRun = {
  setup: Promise<HostedFixture>;
  cleanup: Set<string>;
  live?: Live;
};
const runs = new WeakMap<StepContext['state'], FixtureRun>();

async function setUp(context: StepContext, fixture: FixtureRun): Promise<HostedFixture> {
  const url = new URL(context.config(CONVEX_URL));
  const key = context.secret(DEPLOY_KEY);
  if (url.href !== CONVEX_ORIGIN + '/' || !key.reveal().startsWith(DEPLOYMENT + '|')) {
    throw new Error('The live check requires the designated isolated development deployment');
  }
  const live = {convexUrl: url.origin, serverToken: await serverTokenFromDeployment(key, CLOUD_DIR)};
  fixture.live = live;
  const runId = newRunId();
  const owners = await createLiveOwners(live.convexUrl, 2, {
    deployKey: key, log: message => context.log(message), runId,
    onOwner: userId => fixture.cleanup.add(userId),
  });
  const [a, b] = owners;
  if (owners.length !== 2 || !a || !b || a.userId === b.userId) {
    throw new Error('Expected two distinct disposable owners');
  }
  return {live, runId, owners: [a, b], reader: convexCliReader(key, CLOUD_DIR)};
}

export function hostedFixture(context: StepContext): Promise<HostedFixture> {
  const existing = runs.get(context.state);
  if (existing) return existing.setup;
  const cleanup = new Set<string>();
  const fixture: FixtureRun = {cleanup, setup: Promise.resolve().then(() => setUp(context, fixture))};
  runs.set(context.state, fixture);
  return fixture.setup;
}

export async function cleanOwners(context: StepContext): Promise<StepOutcome> {
  const run = runs.get(context.state);
  runs.delete(context.state);
  if (!run?.live) return {status: 'pass', summary: 'No disposable owners to purge'};
  const live = run.live;
  const client = new ConvexHttpClient(live.convexUrl, {logger: false});
  const results = await Promise.allSettled([...run.cleanup].map(async userId => {
    const scope = {userId, serverToken: live.serverToken.reveal()};
    const active = z.boolean().parse(await client.query(AccountActive, scope));
    if (active) await client.mutation(Begin, scope);
    const result = await purgeUntilDone(live, {userId});
    if (result.status === 'fail') throw new Error(result.summary);
  }));
  const failed = results.filter(result => result.status === 'rejected').length;
  if (failed) return {status: 'fail', summary: `Purge failed for ${failed} of ${results.length} disposable owners`};
  return {status: 'pass', summary: `Confirmed purge for ${results.length} disposable owners`};
}
