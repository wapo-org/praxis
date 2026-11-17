import type {Hono} from 'hono';
import {
 TURN_PATH, TURN_BODY_MAX_BYTES, TURN_SIGNATURE_HEADER, TURN_TIMESTAMP_HEADER, TurnResultSchema,
} from '@praxis/protocol';
import type {AdapterBundle} from '../contracts.js';
import {readLimited} from '../features/tools/http.js';
import {ApiError} from '../service.js';
import {validTurnHeaders, VerifiedTurn, type TurnKeys} from './auth.js';
import {TURN_ALLOW_HEADER, TURN_ERROR, TURN_METHOD} from './constants.js';

export function registerTurnRoute(app: Hono, adapters: AdapterBundle, keys?: TurnKeys, clock = Date.now): void {
 app.all(TURN_PATH, async c => {
  if (c.req.method !== TURN_METHOD) {
   c.header(TURN_ALLOW_HEADER, TURN_METHOD);
   return c.json(TURN_ERROR.method, 405);
  }
  if (!keys) return c.json(TURN_ERROR.unavailable, 503);
  const signature = c.req.header(TURN_SIGNATURE_HEADER);
  const timestamp = c.req.header(TURN_TIMESTAMP_HEADER);
  if (!validTurnHeaders(signature, timestamp, clock())) return c.json(TURN_ERROR.unauthorized, 401);
  let bytes: Uint8Array;
  try {
   bytes = await readLimited(c.req.raw.body, TURN_BODY_MAX_BYTES);
  } catch (error) {
   if (error instanceof ApiError && error.status === 413) return c.json(TURN_ERROR.tooLarge, 413);
   return c.json(TURN_ERROR.invalid, 400);
  }
  if (!validTurnHeaders(signature, timestamp, clock())) return c.json(TURN_ERROR.unauthorized, 401);
  let verified: VerifiedTurn | null;
  try {
   verified = VerifiedTurn.verify(keys, signature!, timestamp!, bytes);
  } catch {
   return c.json(TURN_ERROR.invalid, 400);
  }
  if (!verified) return c.json(TURN_ERROR.unauthorized, 401);
  try {
   if (!await verified.consume(adapters.store)) return c.json(TURN_ERROR.unauthorized, 401);
   if (!adapters.turn) return c.json(TURN_ERROR.unavailable, 503);
   return c.json(TurnResultSchema.parse(await adapters.turn.execute(verified.claims)));
  } catch {
   return c.json(TURN_ERROR.upstream, 503);
  }
 });
}
