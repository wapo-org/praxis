import {
  TURN_FAILURE_MESSAGE_MAX_BYTES, TURN_FAILURE_REMEDIATION_MAX_BYTES, jsonStringBytes, type TurnFailure,
} from '@praxis/protocol';
import {ProviderFailure, runErrorCode} from './provider-error.js';

/** The wire failure for a revoked key or spent credit, sized to fit TurnResultSchema; undefined for any other error. */
export function turnFailure(error: unknown): TurnFailure | undefined {
  const code = runErrorCode(error);
  if (!code || !(error instanceof ProviderFailure)) return undefined;
  return {
    code,
    message: truncateJsonBytes(error.message, TURN_FAILURE_MESSAGE_MAX_BYTES),
    remediation: truncateJsonBytes(error.remediation, TURN_FAILURE_REMEDIATION_MAX_BYTES),
  };
}

/** Longest prefix within `maxBytes` of serialized JSON; cuts between code points, never inside a surrogate pair. */
export function truncateJsonBytes(text: string, maxBytes: number): string {
  if (jsonStringBytes(text) <= maxBytes) return text;
  let kept = '', used = 0;
  for (const codePoint of text) {
    const cost = jsonStringBytes(codePoint);
    if (used + cost > maxBytes) break;
    kept += codePoint;
    used += cost;
  }
  return kept;
}
