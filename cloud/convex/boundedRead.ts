import {ConvexError} from 'convex/values';

/** Reads a range the caller knows is small; more than `max` rows fails closed instead of reading an unbounded range. */
export async function takeBounded<T>(query: {take(count: number): Promise<T[]>}, max: number, what: string): Promise<T[]> {
  const rows = await query.take(max + 1);
  if (rows.length > max) throw new ConvexError(`Too many ${what} rows to read at once`);
  return rows;
}
