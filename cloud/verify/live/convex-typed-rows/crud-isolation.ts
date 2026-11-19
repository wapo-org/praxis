import {setTimeout as sleep} from 'node:timers/promises';
import {ConvexHttpClient} from 'convex/browser';
import type {Run} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import {commitMessages, textMessage, typedApi, type TypedApi} from './api.js';
import {
  AUTH_REQUIRED, CHAT_ID_UNAVAILABLE, check, contiguous, errorText, foreignReadCheck, rejectedCheck, settle, stepResult,
  type Check, type StepResult,
} from './checks.js';
import {authedClient, type LiveOwner} from './owners.js';

export const CHECKLIST = {
  crud: 'Sign in through the web client. Create, read, rename and delete a chat, send messages and page them. Each change persists across a reload.',
  isolation: 'Owner B reads owner A\'s chat, message and run IDs through `chats.get`, `messages.page` and `runs.get`. Every call returns nothing, and an unauthenticated call fails.',
} as const;

const MESSAGE_COUNT = 3;
/** Smaller than MESSAGE_COUNT so paging has to follow the cursor at least once. */
const PAGE_LIMIT = 2;
const RUN_POLL_MS = 1_000;
/** The stub workflow finishes in three turns; a minute covers a cold dev deployment. */
const RUN_SETTLE_MS = 60_000;
const TERMINAL_RUN = new Set<Run['status']>(['completed', 'cancelled', 'failed']);

export type CrudFixture = {
  convexUrl: string;
  runId: string;
  a: LiveOwner;
  b: LiveOwner;
  /** PRAXIS_CONVEX_SERVER_TOKEN of the deployment: `messages.commit` is the worker's path, not the browser's. */
  serverToken: SealedSecret;
  log: (line: string) => void;
};

type Shared = {chatId: string; titles: {a: string; b: string}; messageIds: string[]; runId?: string};

/** A fresh client per read stands in for a page reload: nothing is served from the writer's connection. */
function reloaded(fixture: CrudFixture, owner: LiveOwner): TypedApi {
  return typedApi(authedClient(fixture.convexUrl, owner.token));
}

async function pageAll(api: TypedApi, chatId: string) {
  const pages = [];
  let after: number | undefined;
  for (let index = 0; index <= MESSAGE_COUNT; index += 1) {
    const page = await api.page(chatId, PAGE_LIMIT, after);
    pages.push(page);
    if (!page.hasMore) break;
    after = page.cursor;
  }
  return {pages, messages: pages.flatMap(page => page.messages)};
}

async function waitForRun(api: TypedApi, runId: string): Promise<Run | null> {
  const deadline = Date.now() + RUN_SETTLE_MS;
  for (;;) {
    const run = await api.getRun(runId);
    if (!run || TERMINAL_RUN.has(run.status) || Date.now() >= deadline) return run;
    await sleep(RUN_POLL_MS);
  }
}

export type CrudStep = {id: string; checklist: string; run(): Promise<StepResult>};

/** A throw becomes a failed check, so one broken call never hides the rest of the step's evidence. */
function step(id: string, checklist: string, body: (checks: Check[]) => Promise<void>): CrudStep {
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

export function crudIsolationSteps(fixture: CrudFixture): CrudStep[] {
  const shared: Shared = {
    chatId: `live-pra127-${fixture.runId}-shared`,
    titles: {a: `PRA-127 A ${fixture.runId}`, b: `PRA-127 B ${fixture.runId}`},
    messageIds: [],
  };
  const a = typedApi(fixture.a.client);
  const b = typedApi(fixture.b.client);

  const chatLifecycle = step('owner-chat-lifecycle', CHECKLIST.crud, async checks => {
    const created = await a.createChat(shared.chatId, 'draft');
    checks.push(check('create keeps the client-chosen id', created.id === shared.chatId, created.id === shared.chatId ? 'same id' : 'different id'));
    const renamed = await a.renameChat(shared.chatId, shared.titles.a);
    checks.push(check('rename returns the new title', renamed?.title === shared.titles.a, `title ${JSON.stringify(renamed?.title)}`));
    checks.push(check('rename issues a title revision', !!renamed?.titleRevision && renamed.titleRevision !== created.titleRevision, 'titleRevision changed'));
    const api = reloaded(fixture, fixture.a);
    const read = await api.getChat(shared.chatId);
    checks.push(check('reload reads the renamed chat', read?.title === shared.titles.a, `title ${JSON.stringify(read?.title)}`));
    const listed = await api.listChats();
    checks.push(check('reload lists the chat', listed.some(chat => chat.id === shared.chatId), `${listed.length} chats listed`));
    const again = await settle(a.createChat(shared.chatId, 'duplicate'));
    checks.push(rejectedCheck('the same owner cannot reuse a chat id', again, CHAT_ID_UNAVAILABLE));
    fixture.log(`owner A chat ${shared.chatId} created and renamed`);
  });

  const messagePaging = step('owner-message-paging', CHECKLIST.crud, async checks => {
    const messages = Array.from({length: MESSAGE_COUNT}, (_, index) =>
      textMessage(shared.chatId, `live-pra127-${fixture.runId}-m${index + 1}`, index % 2 ? 'assistant' : 'user', `message ${index + 1}`));
    const committed = await commitMessages(fixture.a.client, fixture.serverToken, fixture.a.userId, shared.chatId, messages);
    shared.messageIds = committed.map(message => message.id);
    const sequences = committed.map(message => message.sequence);
    checks.push(check('commit assigns contiguous sequences', contiguous(sequences), `sequences ${sequences.join(',')}`));
    const {pages, messages: paged} = await pageAll(reloaded(fixture, fixture.a), shared.chatId);
    const ids = paged.map(message => message.id);
    checks.push(check('paging follows the cursor', pages.length > 1 && pages[0]?.hasMore === true, `${pages.length} pages of ${PAGE_LIMIT}`));
    checks.push(check('reload pages every message in order', ids.join() === shared.messageIds.join(), `${ids.length} of ${MESSAGE_COUNT} in order`));
    checks.push(check('paged text matches the commit', paged.every((message, index) => message.parts[0]?.text === `message ${index + 1}`), 'text compared'));
    fixture.log(`owner A committed ${committed.length} messages`);
  });

  const runRead = step('owner-run-read', CHECKLIST.crud, async checks => {
    const runId = await a.startRun(shared.chatId);
    shared.runId = runId;
    const run = await waitForRun(reloaded(fixture, fixture.a), runId);
    checks.push(check('runs.get returns the run', run?.id === runId && run.chatId === shared.chatId, run ? `run in chat ${run.chatId === shared.chatId ? 'A' : 'other'}` : 'null'));
    checks.push(check('the stub workflow completes', run?.status === 'completed', `status ${run?.status ?? 'none'}`));
    fixture.log(`owner A run ${runId} ${run?.status ?? 'missing'}`);
  });

  const foreignReads = step('foreign-owner-reads', CHECKLIST.isolation, async checks => {
    if (!shared.runId || shared.messageIds.length === 0) throw new Error('needs owner A\'s chat, messages and run');
    checks.push(foreignReadCheck('B chats.get(A chat)', await settle(b.getChat(shared.chatId))));
    checks.push(foreignReadCheck('B messages.page(A chat)', await settle(b.page(shared.chatId, PAGE_LIMIT))));
    checks.push(foreignReadCheck('B runs.get(A run)', await settle(b.getRun(shared.runId))));
    checks.push(foreignReadCheck('B chats.patch(A chat)', await settle(b.renameChat(shared.chatId, 'taken over'))));
    checks.push(foreignReadCheck('B chats.remove(A chat)', await settle(b.removeChat(shared.chatId))));
    checks.push(check('B lists none of A\'s chats', !(await b.listChats()).some(chat => chat.id === shared.chatId), 'listed ids compared'));
    const read = await reloaded(fixture, fixture.a).getChat(shared.chatId);
    checks.push(check('A\'s chat is untouched', read?.title === shared.titles.a && !read.deletedAt, `title ${JSON.stringify(read?.title)}`));
  });

  const sameChatId = step('same-client-chat-id', CHECKLIST.isolation, async checks => {
    const created = await b.createChat(shared.chatId, shared.titles.b);
    checks.push(check('B can create a chat with A\'s chat id', created.id === shared.chatId && created.title === shared.titles.b, 'created'));
    const readB = await reloaded(fixture, fixture.b).getChat(shared.chatId);
    const readA = await reloaded(fixture, fixture.a).getChat(shared.chatId);
    checks.push(check('B reads only its own chat', readB?.title === shared.titles.b, `title ${JSON.stringify(readB?.title)}`));
    checks.push(check('A still reads its own chat', readA?.title === shared.titles.a, `title ${JSON.stringify(readA?.title)}`));
    const pageB = await b.page(shared.chatId, PAGE_LIMIT);
    checks.push(check('B pages none of A\'s messages', pageB.messages.length === 0, `${pageB.messages.length} messages`));
    const {messages} = await pageAll(reloaded(fixture, fixture.a), shared.chatId);
    checks.push(check('A keeps all its messages', messages.length === MESSAGE_COUNT, `${messages.length} messages`));
  });

  const unauthenticated = step('unauthenticated-calls', CHECKLIST.isolation, async checks => {
    const anonymous = typedApi(new ConvexHttpClient(fixture.convexUrl, {logger: false}));
    checks.push(rejectedCheck('anonymous chats.get', await settle(anonymous.getChat(shared.chatId)), AUTH_REQUIRED));
    checks.push(rejectedCheck('anonymous chats.list', await settle(anonymous.listChats()), AUTH_REQUIRED));
    checks.push(rejectedCheck('anonymous messages.page', await settle(anonymous.page(shared.chatId, PAGE_LIMIT)), AUTH_REQUIRED));
    checks.push(rejectedCheck('anonymous runs.get', await settle(anonymous.getRun(shared.runId ?? shared.chatId)), AUTH_REQUIRED));
    checks.push(rejectedCheck('anonymous chats.create', await settle(anonymous.createChat(`${shared.chatId}-anon`, 'anon')), AUTH_REQUIRED));
  });

  const chatDeletion = step('owner-chat-delete', CHECKLIST.crud, async checks => {
    checks.push(check('A removes its chat', await a.removeChat(shared.chatId), 'removed'));
    const api = reloaded(fixture, fixture.a);
    checks.push(check('reload no longer reads the chat', await api.getChat(shared.chatId) === null, 'null'));
    checks.push(check('reload no longer lists the chat', !(await api.listChats()).some(chat => chat.id === shared.chatId), 'listed ids compared'));
    checks.push(check('deleted chat pages no messages', (await api.page(shared.chatId, PAGE_LIMIT)).messages.length === 0, 'empty page'));
    if (shared.runId) checks.push(check('deleted chat hides its run', await api.getRun(shared.runId) === null, 'null'));
    const readB = await reloaded(fixture, fixture.b).getChat(shared.chatId);
    checks.push(check('B\'s same-id chat survives A\'s delete', readB?.title === shared.titles.b, `title ${JSON.stringify(readB?.title)}`));
    checks.push(check('B removes its own chat', await b.removeChat(shared.chatId), 'removed'));
  });

  return [chatLifecycle, messagePaging, runRead, foreignReads, sameChatId, unauthenticated, chatDeletion];
}

/** Runs every step in order; later steps still run after a failure so the proof shows each line's own result. */
export async function runCrudIsolation(fixture: CrudFixture): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of crudIsolationSteps(fixture)) results.push(await step.run());
  return results;
}
