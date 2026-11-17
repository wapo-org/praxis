import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {SealedSecret} from '@praxis/types';
import {TurnRequestSchema, TURN_CLOCK_SKEW_MS, type TurnRequest} from '@praxis/protocol';
import type {Store} from '../contracts.js';
import {
 TURN_CURRENT_KEY_ENV, TURN_NEXT_KEY_ENV, TURN_KEY_MIN_CHARACTERS,
 TURN_HMAC_ALGORITHM, TURN_SIGNATURE_HEX_CHARACTERS, TURN_RECEIPT_KIND,
} from './constants.js';

export interface TurnKeys {current: SealedSecret; next?: SealedSecret}

export function readTurnKeys(env: Record<string, string | undefined>): TurnKeys {
 const current = env[TURN_CURRENT_KEY_ENV];
 const next = env[TURN_NEXT_KEY_ENV];
 for (const [name, key] of [[TURN_CURRENT_KEY_ENV, current], [TURN_NEXT_KEY_ENV, next]] as const) {
  if ((name === TURN_CURRENT_KEY_ENV || key !== undefined) && (!key || key.trim().length < TURN_KEY_MIN_CHARACTERS)) {
   throw new Error(`${name} must be at least ${TURN_KEY_MIN_CHARACTERS} characters`);
  }
 }
 return {current: SealedSecret.of(current!), ...(next === undefined ? {} : {next: SealedSecret.of(next)})};
}

export function validTurnHeaders(signature: string | undefined, timestamp: string | undefined, nowMs: number): boolean {
 return !!signature && new RegExp(`^[a-f0-9]{${TURN_SIGNATURE_HEX_CHARACTERS}}$`).test(signature)
  && !!timestamp && /^\d+$/.test(timestamp) && Number.isSafeInteger(Number(timestamp))
  && String(Number(timestamp)) === timestamp && Math.abs(nowMs - Number(timestamp)) <= TURN_CLOCK_SKEW_MS;
}

function verifyTurnBody(keys: TurnKeys, signature: string, timestamp: string, bytes: Uint8Array): boolean {
 const supplied = Buffer.from(signature, 'hex');
 let valid = false;
 for (const key of [keys.current, keys.next].filter((key): key is SealedSecret => key !== undefined)) {
  const expected = createHmac(TURN_HMAC_ALGORITHM, key.reveal()).update(timestamp).update('.').update(bytes).digest();
  valid = timingSafeEqual(expected, supplied) || valid;
 }
 return valid;
}

export class VerifiedTurn {
 private constructor(readonly claims: TurnRequest, readonly receiptId: string, readonly expiresAtMs: number) {}
 static verify(keys: TurnKeys, signature: string, timestamp: string, bytes: Uint8Array): VerifiedTurn | null {
  if (!verifyTurnBody(keys, signature, timestamp, bytes)) return null;
  const claims = TurnRequestSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  const receiptId = createHash(TURN_HMAC_ALGORITHM).update(timestamp).update('.').update(bytes).digest('hex');
  return new VerifiedTurn(claims, receiptId, Number(timestamp) + TURN_CLOCK_SKEW_MS);
 }
 async consume(store: Store): Promise<boolean> {
  // The signed body binds the owner; CAS shares replay authority across instances without storing credentials.
  return !!await store.putIfRevision(this.claims.userId, TURN_RECEIPT_KIND, this.receiptId, {expiresAtMs: this.expiresAtMs}, 0);
 }
}
