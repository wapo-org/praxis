import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { JsonObjectSchema, type JsonObject } from '@praxis/protocol';
import type { ListOptions, Store, StoredRecord } from '../contracts.js';
import { ChangePageSchema, Limit, RecordSchema, Revision, Scope } from './validation.js';

export interface ConvexOptions {
  url: string;
  serverToken: string;
}

/** Minimal RPC surface; the server credential is attached to every call. */
export interface ConvexRPC {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function createConvexRPC(options: ConvexOptions): ConvexRPC {
  z.url().parse(options.url);
  z.string().min(32).parse(options.serverToken);
  const client = new ConvexHttpClient(options.url, { logger: false });
  const withToken = (args: Record<string, unknown>) => ({ ...args, serverToken: options.serverToken });
  return {
    query: (name, args) => client.query(makeFunctionReference<'query'>(name), withToken(args)),
    mutation: (name, args) => client.mutation(makeFunctionReference<'mutation'>(name), withToken(args)),
    action: (name, args) => client.action(makeFunctionReference<'action'>(name), withToken(args)),
  };
}

/** Store plus the compare-and-set write used for checkpoint versions. */
export interface ConvexStore extends Store {
  /** Writes only if the current revision equals `expectedRevision` (0 = absent). Returns null on conflict. */
  putIfRevision(
    userId: string,
    kind: string,
    id: string,
    value: JsonObject,
    expectedRevision: number,
    options?: ListOptions,
  ): Promise<StoredRecord | null>;
}

function address(userId: string, kind: string, id?: string) {
  return {
    userId: Scope.parse(userId),
    kind: Scope.parse(kind),
    ...(id === undefined ? {} : { id: Scope.parse(id) }),
  };
}

function parent(options?: ListOptions) {
  return options?.parentId === undefined ? {} : { parentId: Scope.parse(options.parentId) };
}

/** Drops absent optional fields so callers see the same shape as the memory adapter. */
function toRecord(value: unknown): StoredRecord {
  const row = RecordSchema.parse(value);
  const { parentId, ...rest } = row;
  return parentId === undefined ? rest : { ...rest, parentId };
}

export function storeFromRPC(rpc: ConvexRPC): ConvexStore {
  return {
    async get(userId, kind, id) {
      const row = await rpc.query('store:get', address(userId, kind, id));
      return row === null ? null : toRecord(row);
    },
    async list(userId, kind, options) {
      const rows = z.array(z.unknown()).parse(await rpc.query('store:list', { ...address(userId, kind), ...parent(options) }));
      return rows.map(toRecord);
    },
    async put(userId, kind, id, value, options) {
      const args = { ...address(userId, kind, id), ...parent(options), value: JsonObjectSchema.parse(value) };
      return toRecord(await rpc.mutation('store:put', args));
    },
    async delete(userId, kind, id) {
      await rpc.mutation('store:remove', address(userId, kind, id));
    },
    async changes(userId, after, limit) {
      const args = { userId: Scope.parse(userId), after: Revision.parse(after), limit: Limit.parse(limit) };
      const page = ChangePageSchema.parse(await rpc.query('store:changes', args));
      return { ...page, records: page.records.map(toRecord) };
    },
    async putIfRevision(userId, kind, id, value, expectedRevision, options) {
      const args = {
        ...address(userId, kind, id),
        ...parent(options),
        value: JsonObjectSchema.parse(value),
        expectedRevision: Revision.parse(expectedRevision),
      };
      const row = await rpc.mutation('store:putIfRevision', args);
      return row === null ? null : toRecord(row);
    },
  };
}

export function createConvexStore(options: ConvexOptions): ConvexStore {
  return storeFromRPC(createConvexRPC(options));
}
