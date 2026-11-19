import {execFile} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {ChatSchema, MessageSchema, RunSchema, type Message} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import {ConvexHttpClient} from 'convex/browser';
import {makeFunctionReference} from 'convex/server';
import {ConvexError} from 'convex/values';
import {z} from 'zod';

/** Name of the deployment env var `serverMutation` checks (`cloud/convex/access.ts`). */
export const SERVER_TOKEN_ENV = 'PRAXIS_CONVEX_SERVER_TOKEN';
export const TYPED_TABLES = ['chats', 'messages', 'runs', 'turns', 'sandboxes', 'outputs'] as const;
export type TypedTable = (typeof TYPED_TABLES)[number];
export type RowCounts = Record<TypedTable, number>;
const WORKFLOW_COMPONENT = 'workflow';
const TABLE_READ_ROWS_MAX = 10_000;
const CLI_OUTPUT_BYTES_MAX = 256 * 1024 * 1024;
const PURGE_CALLS_MAX = 500;
const PAGE_LIMIT_MAX = 100;
const SERVER_AUTH_ERROR = 'Server authentication required';

/** Shape of slot A's `createLiveOwners` entries. */
export interface LiveOwner {
  email: string;
  userId: string;
  client: ConvexHttpClient;
}
export interface Live {
  convexUrl: string;
  serverToken: SealedSecret;
}
export interface StepResult {
  status: 'pass' | 'fail';
  summary: string;
  log: string[];
}
/** Lists a table's documents; injected so the checks below run without a deployment. */
export type TableReader = (table: string, component?: string) => Promise<unknown[]>;

const Commit = makeFunctionReference<'mutation'>('messages:commit');
const Page = makeFunctionReference<'query'>('messages:page');
const StorePut = makeFunctionReference<'mutation'>('store:put');
const StoreList = makeFunctionReference<'query'>('store:list');
const StoreHead = makeFunctionReference<'query'>('store:head');
const ChatsList = makeFunctionReference<'query'>('chats:list');
const ChatsCreate = makeFunctionReference<'mutation'>('chats:create');
const Begin = makeFunctionReference<'mutation'>('account:begin');
const Purge = makeFunctionReference<'mutation'>('account:purge');
const Active = makeFunctionReference<'query'>('account:active');

const Committed = z.array(MessageSchema);
const MessagePage = z.object({messages: z.array(MessageSchema), cursor: z.number(), hasMore: z.boolean()});
const PurgeReply = z.object({done: z.boolean(), blobCursor: z.string().optional()});
const OwnedRow = z.object({userId: z.string()});
const RunRow = OwnedRow.extend({workflow: z.object({id: z.string().optional()}).optional()});
const JournalRow = z.object({workflowId: z.string()});
const WorkflowRow = z.object({_id: z.string()});

// ---- pure checks (unit-tested offline) ----

/** Problems when `sequences` is not exactly first..first+n-1 with each value once. */
export function sequenceProblems(sequences: readonly number[], first = 1): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const sequence of sequences) {
    if (seen.has(sequence)) problems.push(`duplicate ${sequence}`);
    seen.add(sequence);
  }
  for (let expected = first; expected < first + sequences.length; expected++) {
    if (!seen.has(expected)) problems.push(`gap at ${expected}`);
  }
  return problems;
}

export function ownerRowCount(rows: readonly unknown[], userId: string): number {
  return rows.filter(row => OwnedRow.safeParse(row).data?.userId === userId).length;
}

export function nonEmptyTables(counts: RowCounts): string[] {
  return TYPED_TABLES.filter(table => counts[table] !== 0).map(table => `${table}=${counts[table]}`);
}

export function changedTables(before: RowCounts, after: RowCounts): string[] {
  return TYPED_TABLES.filter(table => before[table] !== after[table])
    .map(table => `${table} ${before[table]}→${after[table]}`);
}

export function journalRowsFor(steps: readonly unknown[], workflows: readonly unknown[], workflowIds: ReadonlySet<string>) {
  const stepRows = steps.filter(row => workflowIds.has(JournalRow.safeParse(row).data?.workflowId ?? ''));
  const workflowRows = workflows.filter(row => workflowIds.has(WorkflowRow.safeParse(row).data?._id ?? ''));
  return {steps: stepRows.length, workflows: workflowRows.length};
}

// ---- deployment access ----

const run = promisify(execFile);

function cliEnv(deployKey: SealedSecret): NodeJS.ProcessEnv {
  return {...process.env, CONVEX_DEPLOY_KEY: deployKey.reveal()};
}

/** Reads the server token with the deploy key; output never leaves the returned wrapper. */
export async function serverTokenFromDeployment(deployKey: SealedSecret, cwd: string): Promise<SealedSecret> {
  const {stdout} = await run('npx', ['--no-install', 'convex', 'env', 'get', SERVER_TOKEN_ENV], {cwd, env: cliEnv(deployKey)})
    .catch(() => {
      throw new Error(`npx convex env get ${SERVER_TOKEN_ENV} failed`);
    });
  const value = stdout.trim();
  if (value.length < 32) throw new Error(`${SERVER_TOKEN_ENV} is not set on the deployment`);
  return SealedSecret.of(value);
}

/** Admin read through `npx convex data`: the only develop read that sees rows of an inactive owner. */
export function convexCliReader(deployKey: SealedSecret, cwd: string, tail?: number): TableReader {
  return async (table, component) => {
    const args = ['--no-install', 'convex', 'data', table, '--format', 'jsonLines', '--limit', String(tail ?? TABLE_READ_ROWS_MAX)];
    if (component) args.push('--component', component);
    const {stdout} = await run('npx', args, {cwd, env: cliEnv(deployKey), maxBuffer: CLI_OUTPUT_BYTES_MAX}).catch(() => {
      throw new Error(`Convex CLI could not read ${table}`);
    });
    const rows = stdout.trim().split('\n').filter(Boolean).map(line => z.unknown().parse(JSON.parse(line)));
    // A full page means rows were cut off, so a zero count would be unproven.
    if (tail === undefined && rows.length >= TABLE_READ_ROWS_MAX) throw new Error(`${table} exceeds ${TABLE_READ_ROWS_MAX} rows`);
    return rows;
  };
}

function serverClient(live: Live): ConvexHttpClient {
  return new ConvexHttpClient(live.convexUrl, {logger: false});
}

function errorText(error: unknown): string {
  if (error instanceof ConvexError) return String(error.data);
  return error instanceof Error ? error.message : String(error);
}

/** Resolves to the rejection text, or null when the call succeeded. */
async function rejection(call: () => Promise<unknown>): Promise<string | null> {
  return call().then(() => null, errorText);
}

function now(): string {
  return new Date().toISOString();
}

function newMessage(chatId: string, text: string): Message {
  const at = now();
  return MessageSchema.parse({
    type: 'message', id: `live-msg-${randomUUID()}`, chatId, role: 'user', parts: [{type: 'text', text}], createdAt: at, updatedAt: at,
  });
}

async function commit(live: Live, token: string, owner: LiveOwner, chatId: string, messages: Message[]) {
  const reply = await serverClient(live).mutation(Commit, {
    serverToken: token, userId: owner.userId, chatId, messagesJson: JSON.stringify(messages),
  });
  return Committed.parse(reply);
}

async function put(live: Live, owner: LiveOwner, kind: string, id: string, value: object, parentId?: string) {
  await serverClient(live).mutation(StorePut, {
    serverToken: live.serverToken.reveal(), userId: owner.userId, kind, id, valueJson: JSON.stringify(value), requireOwner: true,
    ...(parentId === undefined ? {} : {parentId}),
  });
}

async function readPage(owner: LiveOwner, chatId: string) {
  return MessagePage.parse(await owner.client.query(Page, {chatId, limit: PAGE_LIMIT_MAX}));
}

/** Creates one chat plus a run row so purge has typed rows beyond messages to erase. */
export async function seedOwnerChat(live: Live, owner: LiveOwner): Promise<string> {
  const chatId = `live-chat-${randomUUID()}`;
  const at = now();
  await put(live, owner, 'chat', chatId, ChatSchema.parse({type: 'chat', id: chatId, title: 'PRA-127 live check', mode: 'build', createdAt: at, updatedAt: at}));
  const runId = `live-run-${randomUUID()}`;
  await put(live, owner, 'run', runId, RunSchema.parse({type: 'run', id: runId, chatId, status: 'completed', createdAt: at, updatedAt: at, lastEventId: 0}));
  return chatId;
}

export async function seedOutput(live: Live, owner: LiveOwner, chatId: string): Promise<void> {
  await put(live, owner, 'outputChunk', randomUUID(), {chatId, text: 'PRA-127 disposable output'}, randomUUID());
}

// ---- checklist 5: messages.commit ----

/** Commits `batches` × `size` messages concurrently to a fresh chat and checks the sequences. */
export async function commitConcurrently(live: Live, owner: LiveOwner, batches = 6, size = 3) {
  const chatId = await seedOwnerChat(live, owner);
  const planned = Array.from({length: batches}, (_, b) =>
    Array.from({length: size}, (_, i) => newMessage(chatId, `batch ${b} message ${i}`)));
  const settled = await Promise.allSettled(planned.map(batch => commit(live, live.serverToken.reveal(), owner, chatId, batch)));
  const log = [`${batches} batches of ${size} committed concurrently to one chat`];
  const failures = settled.flatMap(item => item.status === 'rejected' ? [errorText(item.reason)] : []);
  const committed = settled.flatMap(item => item.status === 'fulfilled' ? item.value : []);
  const problems = failures.map(text => `commit rejected: ${text}`);
  for (const batch of settled) {
    if (batch.status !== 'fulfilled') continue;
    const sequences = batch.value.map(message => message.sequence ?? 0);
    problems.push(...sequenceProblems(sequences, sequences[0] ?? 1).map(p => `batch not consecutive: ${p}`));
  }
  const returned = committed.map(message => message.sequence ?? 0);
  problems.push(...sequenceProblems(returned).map(p => `returned ${p}`));
  const page = await readPage(owner, chatId);
  const stored = page.messages.map(message => message.sequence ?? 0);
  if (stored.length !== batches * size) problems.push(`page holds ${stored.length} messages, expected ${batches * size}`);
  problems.push(...sequenceProblems(stored).map(p => `stored ${p}`));
  log.push(`returned sequences ${[...returned].sort((a, b) => a - b).join(',')}`, `stored sequences ${stored.join(',')}`);
  const result = verdict(problems, `${batches * size} messages hold sequences 1..${batches * size} with no gap or duplicate`, log);
  return {result, chatId, committed};
}

/** Re-commits an existing message ID with new text; its sequence must not move. */
export async function recommitKeepsSequence(live: Live, owner: LiveOwner, chatId: string, original: Message): Promise<StepResult> {
  const {sequence: _sequence, ...rest} = original;
  const text = 'edited by PRA-127 live check';
  const edited = {...rest, parts: [{type: 'text' as const, text}], updatedAt: now()};
  const [again] = await commit(live, live.serverToken.reveal(), owner, chatId, [edited]);
  const page = await readPage(owner, chatId);
  const stored = page.messages.find(message => message.id === original.id);
  const problems: string[] = [];
  if (again?.sequence !== original.sequence) problems.push(`commit returned ${again?.sequence}, was ${original.sequence}`);
  if (stored?.sequence !== original.sequence) problems.push(`stored ${stored?.sequence}, was ${original.sequence}`);
  if (stored?.parts[0]?.text !== text) problems.push('stored text was not updated');
  problems.push(...sequenceProblems(page.messages.map(message => message.sequence ?? 0)).map(p => `stored ${p}`));
  return verdict(problems, `message keeps sequence ${original.sequence} after re-commit`, [`${page.messages.length} messages after re-commit`]);
}

/** Commits with a wrong and an empty token; both must be refused before any row is written. */
export async function rejectsBadCredential(live: Live, owner: LiveOwner, chatId: string): Promise<StepResult> {
  const before = (await readPage(owner, chatId)).messages.length;
  const attempts = [['wrong', randomBytes(32).toString('hex')], ['empty', '']] as const;
  const problems: string[] = [];
  const log: string[] = [];
  for (const [label, token] of attempts) {
    const text = await rejection(() => commit(live, token, owner, chatId, [newMessage(chatId, `${label} token`)]));
    log.push(`${label} token: ${text ?? 'accepted'}`);
    if (text !== SERVER_AUTH_ERROR) problems.push(`${label} token was not refused with "${SERVER_AUTH_ERROR}"`);
  }
  const after = (await readPage(owner, chatId)).messages.length;
  if (after !== before) problems.push(`message count moved ${before}→${after}`);
  return verdict(problems, 'wrong and empty server credentials are refused', log);
}

// ---- checklist 4: account.begin / account.purge ----

export async function snapshotOwner(reader: TableReader, userId: string) {
  const counts = {} as RowCounts;
  const workflowIds = new Set<string>();
  for (const table of TYPED_TABLES) {
    const rows = await reader(table);
    counts[table] = ownerRowCount(rows, userId);
    if (table !== 'runs') continue;
    for (const row of rows) {
      const parsed = RunRow.safeParse(row).data;
      if (parsed?.userId === userId && parsed.workflow?.id) workflowIds.add(parsed.workflow.id);
    }
  }
  return {counts, workflowIds};
}

export async function snapshotJournal(reader: TableReader, workflowIds: ReadonlySet<string>) {
  const [steps, workflows] = await Promise.all([
    reader('steps', WORKFLOW_COMPONENT),
    reader('workflows', WORKFLOW_COMPONENT),
  ]);
  return journalRowsFor(steps, workflows, workflowIds);
}

/** Begins deletion for `owner`; every client read, client write and server typed write must then be refused. */
export async function beginFencesOwner(live: Live, owner: LiveOwner, chatId: string): Promise<StepResult> {
  await serverClient(live).mutation(Begin, {serverToken: live.serverToken.reveal(), userId: owner.userId});
  const at = now();
  const chat = ChatSchema.parse({type: 'chat', id: chatId, title: 'after begin', mode: 'build', createdAt: at, updatedAt: at});
  const attempts: [string, () => Promise<unknown>][] = [
    ['client chats:list', () => owner.client.query(ChatsList, {})],
    ['client messages:page', () => owner.client.query(Page, {chatId, limit: 1})],
    ['client chats:create', () => owner.client.mutation(ChatsCreate, {input: {type: 'chat.input'}})],
    ['server messages:commit', () => commit(live, live.serverToken.reveal(), owner, chatId, [newMessage(chatId, 'after begin')])],
    ['server store:put chat', () => put(live, owner, 'chat', chatId, chat)],
  ];
  const log: string[] = [];
  const problems: string[] = [];
  for (const [label, call] of attempts) {
    const text = await rejection(call);
    log.push(`${label}: ${text ?? 'accepted'}`);
    if (text === null) problems.push(`${label} was accepted after begin`);
  }
  return verdict(problems, 'owner reads and typed writes are fenced after account:begin', log);
}

export async function purgeUntilDone(live: Live, owner: Pick<LiveOwner, 'userId'>): Promise<StepResult> {
  let blobCursor: string | undefined;
  for (let call = 1; call <= PURGE_CALLS_MAX; call++) {
    const reply = PurgeReply.parse(await serverClient(live).mutation(Purge, {
      serverToken: live.serverToken.reveal(), userId: owner.userId, ...(blobCursor ? {blobCursor} : {}),
    }));
    if (reply.done) return verdict([], `account:purge reported done after ${call} call(s)`, []);
    blobCursor = reply.blobCursor ?? blobCursor;
  }
  return verdict([`not done after ${PURGE_CALLS_MAX} calls`], '', []);
}

/** Zero rows for the purged owner in the six typed tables, the workflow journal and every server read. */
export async function assertOwnerPurged(live: Live, reader: TableReader, owner: LiveOwner, workflowIds: ReadonlySet<string>): Promise<StepResult> {
  const log = ['develop has no server-credential read of an inactive owner\'s typed rows; counts come from `npx convex data`'];
  const {counts} = await snapshotOwner(reader, owner.userId);
  const problems = nonEmptyTables(counts).map(entry => `rows left: ${entry}`);
  const journal = await snapshotJournal(reader, workflowIds);
  log.push(`after purge: ${TYPED_TABLES.map(table => `${table}=${counts[table]}`).join(' ')}`);
  log.push(`workflow ids before purge: ${workflowIds.size}; journal steps left ${journal.steps}, workflows left ${journal.workflows}`);
  if (journal.steps || journal.workflows) problems.push('workflow journal rows left');
  const server = serverClient(live);
  const scope = {serverToken: live.serverToken.reveal(), userId: owner.userId};
  const head = z.number().parse(await server.query(StoreHead, scope));
  const active = z.boolean().parse(await server.query(Active, scope));
  if (head !== 0) problems.push(`store:head is ${head}, changes rows remain`);
  if (active) problems.push('account:active is still true');
  for (const kind of ['chat', 'message', 'run', 'outputChunk']) {
    const rows = z.array(z.unknown()).parse(await server.query(StoreList, {...scope, kind}));
    if (rows.length) problems.push(`store:list ${kind} returned ${rows.length}`);
  }
  log.push(`store:head ${head}, account:active ${active}`);
  return verdict(problems, 'no rows remain for the purged owner', log);
}

/** The other owner's row counts and message sequences are unchanged by the purge. */
export async function assertOwnerUnchanged(
  reader: TableReader, owner: LiveOwner, before: RowCounts, chatId: string, beforeMessages: readonly Message[],
): Promise<StepResult> {
  const {counts} = await snapshotOwner(reader, owner.userId);
  const problems = changedTables(before, counts).map(entry => `row count changed: ${entry}`);
  const key = (messages: readonly Message[]) => messages.map(message => `${message.id}@${message.sequence}`).join(',');
  const page = await readPage(owner, chatId);
  if (key(page.messages) !== key(beforeMessages)) problems.push('message ids or sequences changed');
  const log = [`counts ${TYPED_TABLES.map(table => `${table}=${counts[table]}`).join(' ')}`];
  return verdict(problems, 'the other owner\'s rows are unchanged', log);
}

function verdict(problems: readonly string[], passSummary: string, log: string[]): StepResult {
  if (problems.length) return {status: 'fail', summary: problems.join('; '), log};
  return {status: 'pass', summary: passSummary, log};
}
