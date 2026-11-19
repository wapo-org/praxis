import {setTimeout as sleep} from 'node:timers/promises';
import {TurnResultSchema, type Run, type TurnResult} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import {z} from 'zod';
import {STUB_TURNS_MAX, WORKFLOW_PARALLELISM_MAX} from '../../../convex/workflows/constants.js';
import {typedApi, type TypedApi} from '../convex-typed-rows/api.js';
import {check, errorText, settle, stepResult, type Check, type Settled, type StepResult} from '../convex-typed-rows/checks.js';
import type {TableReader} from '../convex-typed-rows/commit-purge.js';
import type {LiveOwner} from '../convex-typed-rows/owners.js';

export const CHECKLIST = {
  redelivery: 'Two concurrent redeliveries of `turns.run` for the same `expectedTurnIndex` return identical flags and write one `turnFlags` row.',
  capacity: 'Workpool parallelism of 4 leaves capacity on the hosted plan’s scheduled-job limit.',
} as const;

/** Convex's HTTP API path for running any action; internal ones need the deployment's admin key. */
const ACTION_PATH = '/api/action';
const TURN_RUN_FUNCTION = 'turns:run';
/** The workflow component mounts its workpool as `workflow/workpool`; `globals` holds the live config row. */
const WORKPOOL_COMPONENT = 'workflow/workpool';
const WORKPOOL_GLOBALS_TABLE = 'globals';
const RUN_POLL_MS = 1_000;
/** Covers a cold dev deployment draining more runs than the pool runs at once. */
const RUN_SETTLE_MS = 120_000;
const TERMINAL_RUN = new Set<Run['status']>(['completed', 'cancelled', 'failed']);

/** One more run than the pool's slots, so at least one run has to queue behind the others. */
export const CAPACITY_RUNS = WORKFLOW_PARALLELISM_MAX + 1;

/** Convex limits page, "Concurrent Function Executions" and "Deployment Classes" (read 2026-11-19). */
export const CONVEX_LIMITS = {
  url: 'https://docs.convex.dev/production/state/limits#concurrent-function-executions',
  /** Free and Starter run on S16; Professional on S256. S16 bounds every plan the deployment can be on. */
  s16ScheduledJobsMax: 8,
  s256ScheduledJobsMax: 256,
} as const;

/** PRA-10 Decisions (from PRA-95): two slots stay free for workflow/workpool bookkeeping, crons and cleanup jobs. */
export const RESERVED_SCHEDULED_JOBS = 2;

export type AdminAction = (path: string, args: Record<string, unknown>) => Promise<unknown>;

export type RedeliveryFixture = {
  runId: string;
  owner: LiveOwner;
  /** Calls internal functions as the deployment admin, the same authority the workflow's workpool has. */
  adminAction: AdminAction;
  reader: TableReader;
  log: (line: string) => void;
};

const FunctionReply = z.discriminatedUnion('status', [
  z.object({status: z.literal('success'), value: z.unknown()}),
  z.object({status: z.literal('error'), errorMessage: z.string(), errorData: z.unknown().optional()}),
]);
const TurnRow = z.object({
  _creationTime: z.number(), userId: z.string(), runId: z.string(), generation: z.number(),
  turnIndex: z.number(), done: z.boolean(), status: z.string(),
});
export type TurnRowValue = z.infer<typeof TurnRow>;
const WorkpoolGlobals = z.object({maxParallelism: z.number().int()});

/** Each call is its own HTTP request, so two calls in flight are two independent deliveries. */
export function adminActionCaller(convexUrl: string, deployKey: SealedSecret): AdminAction {
  return async (path, args) => {
    const response = await fetch(new URL(ACTION_PATH, convexUrl), {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Convex ${deployKey.reveal()}`},
      body: JSON.stringify({path, args, format: 'json'}),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    const reply = FunctionReply.parse(await response.json());
    if (reply.status === 'error') throw new Error(reply.errorMessage);
    return reply.value;
  };
}

// ---- pure checks (unit-tested offline) ----

type RunKey = {userId: string; runId: string; generation: number};

export function turnRowsFor(rows: readonly unknown[], key: RunKey): TurnRowValue[] {
  return rows.flatMap(row => {
    const parsed = TurnRow.safeParse(row).data;
    const matches = parsed && parsed.userId === key.userId && parsed.runId === key.runId && parsed.generation === key.generation;
    return matches ? [parsed] : [];
  });
}

/** Key order differs between the insert and saved-row paths, so compare a sorted rendering. */
export function canonicalFlags(flags: TurnResult): string {
  return JSON.stringify(Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))));
}

export function redeliveryChecks(
  label: string, replies: readonly Settled<TurnResult>[], rows: readonly TurnRowValue[], expected: TurnResult,
): Check[] {
  const checks: Check[] = [];
  const values = replies.flatMap(reply => reply.ok ? [reply.value] : []);
  const failures = replies.flatMap(reply => reply.ok ? [] : [errorText(reply.error)]);
  checks.push(check(`${label}: every redelivery succeeded`, failures.length === 0 && values.length === replies.length,
    failures.length ? `rejected: ${failures.join(' | ')}` : `${values.length} replies`));
  const rendered = [...new Set(values.map(canonicalFlags))];
  checks.push(check(`${label}: replies are identical`, values.length > 1 && rendered.length === 1, rendered.join(' vs ')));
  checks.push(check(`${label}: replies match the committed turn`, rendered.length === 1 && rendered[0] === canonicalFlags(expected),
    `expected ${canonicalFlags(expected)}`));
  const atIndex = rows.filter(row => row.turnIndex === expected.turnIndex);
  checks.push(check(`${label}: one turns row for index ${expected.turnIndex}`, atIndex.length === 1, `${atIndex.length} rows`));
  const row = atIndex[0];
  const rowMatches = !!row && row.done === expected.done && row.status === expected.status;
  checks.push(check(`${label}: row flags match the replies`, rowMatches, row ? `done=${row.done} status=${row.status}` : 'no row'));
  return checks;
}

/** The stub writes indices start..start+STUB_TURNS_MAX-1, each exactly once. */
export function wholeRunChecks(label: string, rows: readonly TurnRowValue[], startTurnIndex = 0): Check[] {
  const indices = rows.map(row => row.turnIndex).sort((a, b) => a - b);
  const expected = Array.from({length: STUB_TURNS_MAX}, (_, offset) => startTurnIndex + offset);
  return [check(`${label}: each stub turn written once`, indices.join(',') === expected.join(','),
    `indices [${indices.join(',')}], expected [${expected.join(',')}]`)];
}

export function capacityChecks(sourceParallelism: number, deployedParallelism: number | null): Check[] {
  const {s16ScheduledJobsMax, s256ScheduledJobsMax, url} = CONVEX_LIMITS;
  const headroom = s16ScheduledJobsMax - sourceParallelism - RESERVED_SCHEDULED_JOBS;
  return [
    check('deployed workpool maxParallelism equals the source constant', deployedParallelism === sourceParallelism,
      `source ${sourceParallelism}, deployed ${deployedParallelism ?? 'missing'}`),
    check('parallelism plus reserved slots fits S16 scheduled jobs',
      sourceParallelism + RESERVED_SCHEDULED_JOBS <= s16ScheduledJobsMax,
      `${sourceParallelism} + ${RESERVED_SCHEDULED_JOBS} reserved <= ${s16ScheduledJobsMax} (Free/Starter, ${url}); headroom ${headroom}`),
    check('parallelism fits S256 scheduled jobs', sourceParallelism + RESERVED_SCHEDULED_JOBS <= s256ScheduledJobsMax,
      `${sourceParallelism} + ${RESERVED_SCHEDULED_JOBS} <= ${s256ScheduledJobsMax} (Professional)`),
  ];
}

export function settledRunsChecks(runs: readonly (Run | null)[], expectedCount: number): Check[] {
  const statuses = runs.map(run => run?.status ?? 'missing');
  return [
    check('every concurrent run settled completed', runs.length === expectedCount && statuses.every(status => status === 'completed'),
      `${runs.length}/${expectedCount} runs: ${statuses.join(',')}`),
  ];
}

// ---- hosted steps ----

async function waitForRun(api: TypedApi, runId: string): Promise<Run | null> {
  const deadline = Date.now() + RUN_SETTLE_MS;
  for (;;) {
    const run = await api.getRun(runId);
    if (!run || TERMINAL_RUN.has(run.status) || Date.now() >= deadline) return run;
    await sleep(RUN_POLL_MS);
  }
}

async function redeliver(fixture: RedeliveryFixture, args: Record<string, unknown>, count: number) {
  const calls = Array.from({length: count}, async () =>
    TurnResultSchema.parse(await fixture.adminAction(TURN_RUN_FUNCTION, args)));
  return Promise.all(calls.map(call => settle(call)));
}

function flagsOf(row: TurnRowValue | undefined): TurnResult | null {
  if (!row) return null;
  return TurnResultSchema.parse({done: row.done, status: row.status, subagents: [], turnIndex: row.turnIndex});
}

export type LiveStep = {id: string; checklist: string; run(): Promise<StepResult>};

function step(id: string, checklist: string, body: (checks: Check[]) => Promise<void>): LiveStep {
  return {id, checklist, run: async () => {
    const checks: Check[] = [];
    try {
      await body(checks);
    } catch (error) {
      checks.push(check('step completed', false, `threw: ${errorText(error)}`));
    }
    return stepResult(id, checklist, checks);
  }};
}

/** Fires redeliveries of turn 0 right after start, racing the workflow's own delivery, then again after completion. */
export function redeliveryStep(fixture: RedeliveryFixture): LiveStep {
  return step('turn-redelivery', CHECKLIST.redelivery, async checks => {
    const api = typedApi(fixture.owner.client);
    const chatId = `live-pra125-${fixture.runId}-redelivery`;
    await api.createChat(chatId, 'PRA-125 redelivery');
    const runId = await api.startRun(chatId);
    const key = {userId: fixture.owner.userId, runId, generation: 0};
    const scope = {...key, chatId};
    const sentAt = Date.now();
    const first = await redeliver(fixture, {...scope, expectedTurnIndex: 0}, 2);
    const run = await waitForRun(api, runId);
    checks.push(check('run settled completed', run?.status === 'completed', run?.status ?? 'missing'));
    const lastIndex = STUB_TURNS_MAX - 1;
    const late = await redeliver(fixture, {...scope, expectedTurnIndex: lastIndex}, 2);
    const rows = turnRowsFor(await fixture.reader('turns'), key);
    const firstRow = rows.find(row => row.turnIndex === 0);
    const lastRow = rows.find(row => row.turnIndex === lastIndex);
    // Client and server clocks differ, so the offset only shows which path the race took; it is not asserted.
    fixture.log(`turn 0 row created ${firstRow ? Math.round(firstRow._creationTime - sentAt) : 'n/a'} ms after the redeliveries were sent`);
    const firstExpected = flagsOf(firstRow) ?? TurnResultSchema.parse({done: false, status: 'ready', subagents: [], turnIndex: 0});
    const lastExpected = flagsOf(lastRow) ?? TurnResultSchema.parse({done: true, status: 'completed', subagents: [], turnIndex: lastIndex});
    checks.push(check('turn 0 is a ready turn', firstExpected.status === 'ready' && !firstExpected.done, canonicalFlags(firstExpected)));
    checks.push(check(`turn ${lastIndex} completes the run`, lastExpected.status === 'completed' && lastExpected.done, canonicalFlags(lastExpected)));
    checks.push(...redeliveryChecks('racing the workflow', first, rows, firstExpected));
    checks.push(...redeliveryChecks('after completion', late, rows, lastExpected));
    checks.push(...wholeRunChecks('whole run', rows));
  });
}

/** Compares the deployed pool size with the plan limit, then saturates the pool and waits for every run. */
export function capacityStep(fixture: RedeliveryFixture): LiveStep {
  return step('workpool-capacity', CHECKLIST.capacity, async checks => {
    const globals = (await fixture.reader(WORKPOOL_GLOBALS_TABLE, WORKPOOL_COMPONENT))
      .flatMap(row => WorkpoolGlobals.safeParse(row).data ?? []);
    const deployed = globals.length === 1 ? globals[0]?.maxParallelism ?? null : null;
    checks.push(check('one workpool globals row', globals.length === 1, `${globals.length} rows`));
    checks.push(...capacityChecks(WORKFLOW_PARALLELISM_MAX, deployed));
    const api = typedApi(fixture.owner.client);
    const chatIds = Array.from({length: CAPACITY_RUNS}, (_, index) => `live-pra125-${fixture.runId}-capacity-${index}`);
    await Promise.all(chatIds.map(chatId => api.createChat(chatId, 'PRA-125 capacity')));
    const startedAt = Date.now();
    const runIds = await Promise.all(chatIds.map(chatId => api.startRun(chatId)));
    const runs = await Promise.all(runIds.map(runId => waitForRun(api, runId)));
    fixture.log(`${CAPACITY_RUNS} runs settled within ${Date.now() - startedAt} ms`);
    checks.push(...settledRunsChecks(runs, CAPACITY_RUNS));
    const turns = await fixture.reader('turns');
    for (const [index, runId] of runIds.entries()) {
      checks.push(...wholeRunChecks(`run ${index}`, turnRowsFor(turns, {userId: fixture.owner.userId, runId, generation: 0})));
    }
  });
}
