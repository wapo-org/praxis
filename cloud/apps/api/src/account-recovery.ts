import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER,
  AccountDeleteRecoverySchema,
} from '@praxis/protocol';
import { SealedSecret } from '@praxis/types';
import { ContinuationAuthError } from './adapters/qstash.js';
import { readLimited } from './features/tools/http.js';

const ACCOUNT_RECOVERY_BODY_MAX_BYTES = 4096;

export function verifyAccountRecovery(secret: SealedSecret) {
  return async (request: Request) => {
    const signature = request.headers.get(ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER);
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new ContinuationAuthError('Invalid deletion recovery signature');
    }
    const body = await readLimited(request.body, ACCOUNT_RECOVERY_BODY_MAX_BYTES);
    const expected = createHmac('sha256', secret.reveal()).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new ContinuationAuthError('Invalid deletion recovery signature');
    }
    return AccountDeleteRecoverySchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)));
  };
}
