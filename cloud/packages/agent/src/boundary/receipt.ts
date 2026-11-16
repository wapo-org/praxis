import {ApprovalBindingSchema, ApprovalReceiptWireSchema, type ApprovalBinding, type ApprovalReceiptWire} from '@praxis/protocol';
import {canonical as canonicalArgs} from '../policy.js';
export {canonical as canonicalArgs, fingerprint as argsHash} from '../policy.js';
import type {SealedSecret} from '@praxis/types';

export const APPROVAL_SECRET_MIN_BYTES = 32;
const encoder = new TextEncoder();
const HMAC_ALGORITHM = {name: 'HMAC', hash: 'SHA-256'} as const;
const RECEIPT_DOMAIN = 'praxis.tool-approval.v1';

// A durable adapter must atomically consume a nonce before executing its approved call.
export interface ApprovalReplayStore {
  consume(nonce: string, expiresAtMs: number): Promise<boolean>;
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export class ApprovalReceipt {
  readonly #binding: ApprovalBinding;
  private constructor(binding: ApprovalBinding) {
    this.#binding = Object.freeze({...binding});
  }
  matches(binding: ApprovalBinding): boolean {
    return canonicalArgs(this.#binding) === canonicalArgs(binding);
  }
  static async verify(wire: unknown, binding: ApprovalBinding, nowMs: number, key: CryptoKey, replay: ApprovalReplayStore): Promise<ApprovalReceipt | null> {
    const parsed = ApprovalReceiptWireSchema.safeParse(wire);
    if (!parsed.success || !Number.isFinite(nowMs)) return null;
    const {payload, signature} = parsed.data;
    if (payload.expiresAtMs <= nowMs) return null;
    const expected = ApprovalBindingSchema.safeParse(binding);
    if (!expected.success || Object.entries(expected.data).some(([k, v]) => payload[k as keyof typeof payload] !== v)) return null;
    const bytes = new Uint8Array(signature.match(/../g)!.map(b => Number.parseInt(b, 16)));
    if (!await crypto.subtle.verify('HMAC', key, bytes, receiptMessage(payload))) return null;
    if (!await replay.consume(payload.nonce, payload.expiresAtMs)) return null;
    return new ApprovalReceipt(expected.data);
  }
}
function receiptMessage(payload: ApprovalReceiptWire['payload']): Uint8Array<ArrayBuffer> {
  return encoder.encode(RECEIPT_DOMAIN + canonicalArgs(payload));
}
export async function approvalKey(secret: SealedSecret): Promise<CryptoKey> {
  const bytes = encoder.encode(secret.reveal());
  if (bytes.length < APPROVAL_SECRET_MIN_BYTES) throw new Error('Approval HMAC key is too short');
  return crypto.subtle.importKey('raw', bytes, HMAC_ALGORITHM, false, ['sign', 'verify']);
}

// Only the authenticated approval service may issue; never expose this operation as a model tool.
export async function issueApproval(key: CryptoKey, binding: ApprovalBinding, expiresAtMs: number, nonce: string): Promise<ApprovalReceiptWire> {
  const payload = ApprovalReceiptWireSchema.shape.payload.parse({...binding, version: 1, expiresAtMs, nonce});
  const signature = hex(await crypto.subtle.sign('HMAC', key, receiptMessage(payload)));
  return {payload, signature};
}
