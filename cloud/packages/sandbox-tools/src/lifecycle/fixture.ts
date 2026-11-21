import {convexTest} from 'convex-test';
import {makeFunctionReference} from 'convex/server';
import {expect} from 'vitest';
import {MODAL_POOL, memoryCooldownStore, pool} from '@praxis/credentials';
import schema from '../../../../convex/schema.js';
import {FakeModal} from './fake-modal.js';
import type {ModalCredential, SandboxLogEvent, SandboxRows} from './ports.js';
import {sandboxResolver, SandboxUnavailableError} from './resolver.js';
import {convexSandboxRows, type ConvexMutations} from './rows.js';

// Shared by the lifecycle (PRA-52) and free-tier (PRA-170) suites: real Convex functions, a fake Modal.

export const SERVER_TOKEN = 'sandbox-test-server-token-longer-than-32-characters';
export const CREDENTIALS = {
  MODAL_TOKEN_ID: 'ak-slot-one-token-id', MODAL_TOKEN_SECRET: 'as-slot-one-token-secret',
  MODAL_TOKEN_ID_2: 'ak-slot-two-token-id', MODAL_TOKEN_SECRET_2: 'as-slot-two-token-secret',
};

/** convex-test resolves the functions root from the `_generated` entry. */
const modules = {
  '../../../../convex/_generated/api.js': async () => ({}),
  '../../../../convex/functions.ts': () => import('../../../../convex/functions.js'),
  '../../../../convex/sandboxes.ts': () => import('../../../../convex/sandboxes.js'),
};

export function setup(env: Record<string, string> = CREDENTIALS) {
  const t = convexTest(schema, modules);
  const rpc: ConvexMutations = {
    mutation: (name, args) => t.mutation(makeFunctionReference<'mutation'>(name), {...args, serverToken: SERVER_TOKEN}),
  };
  const modal = new FakeModal();
  const cooldowns = memoryCooldownStore();
  const logs: SandboxLogEvent[] = [];
  const modalPool = pool(MODAL_POOL.names, env, {service: MODAL_POOL.service});
  const resolverWith = (rows: SandboxRows) => sandboxResolver({
    rows, pool: modalPool, cooldowns, log: event => logs.push(event),
    account: (credential: ModalCredential) => modal.account(credential),
    sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
  });
  const rows = convexSandboxRows(rpc);
  const owner = (fields: {deleting?: boolean} = {}) => t.run(ctx => ctx.db.insert('users', fields));
  const row = (userId: string) => t.run(ctx => ctx.db.query('sandboxes')
    .withIndex('by_user_scope', q => q.eq('userId', userId).eq('scope', 'workspace')).unique());
  return {t, rpc, rows, modal, cooldowns, logs, modalPool, resolver: resolverWith(rows), resolverWith, owner, row};
}

export async function failure(work: Promise<unknown>): Promise<SandboxUnavailableError> {
  const error = await work.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(SandboxUnavailableError);
  return error as SandboxUnavailableError;
}

