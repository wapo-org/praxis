import {convexTest} from 'convex-test';
import {registerCore, sessionIdentity} from '@convex-dev/auth/test';
import workflowComponent from '@convex-dev/workflow/test';
import schema from '../convex/schema.js';
import {api, components} from '../convex/_generated/api.js';

export const chatId = 'workflow-chat';
export const SERVER_TOKEN = 'workflow-test-server-token-longer-than-32-characters';
const ACCESS_TTL_SECONDS = 3600;
const SESSION_TTL_SECONDS = 7200;
const modules = {
  '../convex/_generated/api.js': () => import('../convex/_generated/api.js'),
  '../convex/account.ts': () => import('../convex/account.js'),
  '../convex/runs.ts': () => import('../convex/runs.js'),
  '../convex/turns.ts': () => import('../convex/turns.js'),
  '../convex/workflows/agentRun.ts': () => import('../convex/workflows/agentRun.js'),
};

export function workflowTest() {
  const t = convexTest(schema, modules);
  registerCore(t);
  workflowComponent.register(t);
  return t;
}
type WorkflowTest = ReturnType<typeof workflowTest>;

// Auth v2 tokens carry the session id as subject, so tests mint a real session for a real `users` row.
export async function signedInUser(t: WorkflowTest) {
  const userId = await t.run(ctx => ctx.db.insert('users', {}));
  const tokens = await t.run(ctx => ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
    claims: {method: 'test', profile: {}}, componentPath: 'auth', userId,
    accessTokenTtlSeconds: ACCESS_TTL_SECONDS, refreshInactivityTimeoutSeconds: SESSION_TTL_SECONDS,
    sessionMaxLifetimeSeconds: SESSION_TTL_SECONDS,
  }));
  return {userId, client: t.withIdentity(sessionIdentity(tokens))};
}

export async function startedRun() {
  const t = workflowTest();
  const {userId, client: owner} = await signedInUser(t);
  await t.run(ctx => ctx.db.insert('records', {
    userId, kind: 'chat', id: chatId, value: {}, revision: 1, updatedAt: new Date().toISOString(), deleted: false,
  }));
  const runId = await owner.mutation(api.runs.start, {chatId});
  const scope = {userId, chatId, runId, generation: 0};
  return {t, owner, userId, runId, scope};
}
