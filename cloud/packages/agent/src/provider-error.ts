import {classifyHttp, retryAfterMs, type HeadersLike} from '@praxis/credentials';
import type {RunErrorCode, ToolError} from '@praxis/protocol';
import {toolError} from './boundary/errors.js';

export const PROVIDER_FAILURE_KINDS = [
  'keyInvalid', 'creditExhausted', 'rateLimited', 'unavailable', 'modelUnavailable', 'context', 'fatal',
] as const;
export type ProviderFailureKind = typeof PROVIDER_FAILURE_KINDS[number];

interface KindPolicy {
  /** A retry inside the same turn can succeed without anyone acting. */
  retryable: boolean;
  remediation: string;
}

const POLICY: Record<ProviderFailureKind, KindPolicy> = {
  keyInvalid: {retryable: false, remediation: 'Reconnect OpenRouter in Settings, then send the message again.'},
  creditExhausted: {retryable: false, remediation: 'Add credit to your OpenRouter account, then send the message again.'},
  rateLimited: {retryable: true, remediation: 'Wait a moment and send the message again.'},
  unavailable: {retryable: true, remediation: 'OpenRouter or the model provider is unavailable; try again shortly.'},
  modelUnavailable: {retryable: false, remediation: 'Choose another model, or check your OpenRouter privacy settings for this model.'},
  context: {retryable: false, remediation: 'Start a new chat or shorten the conversation.'},
  fatal: {retryable: false, remediation: 'Try again, or choose another model if it keeps failing.'},
};

/** 403 from OpenRouter is a moderation refusal of this input, not a bad key. */
const MODERATION_REMEDIATION = 'Rephrase the request; the model provider’s moderation flagged this input.';

export interface ProviderFailureOptions {
  retryAfterMs?: number | undefined;
  status?: number | undefined;
  remediation?: string | undefined;
  cause?: unknown;
}

export class ProviderFailure extends Error {
  readonly retryable: boolean;
  readonly remediation: string;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(readonly kind: ProviderFailureKind, message: string, options: ProviderFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = 'ProviderFailure';
    this.retryable = POLICY[kind].retryable;
    this.remediation = options.remediation ?? POLICY[kind].remediation;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }

  /** Same failure with a different message, used to redact key material before it leaves the provider. */
  withMessage(message: string): ProviderFailure {
    return new ProviderFailure(this.kind, message, {
      retryAfterMs: this.retryAfterMs, status: this.status, remediation: this.remediation,
    });
  }
}

const CONTEXT_TEXT = /context[_ ]?(length|window)|prompt.{0,8}too long|too many (input )?tokens|maximum context|request_too_large/i;
const MODEL_TEXT = /not a valid model|model .{0,80}(?:does not exist|not found)|no endpoints found/i;

/** Status-coded OpenRouter errors; credential statuses go through `@praxis/credentials` so pools and runs agree. */
export function classifyProviderError(status: number, message: string, headers?: HeadersLike): ProviderFailure {
  const signal = classifyHttp(status, headers, message);
  if (signal.kind === 'exhausted') return new ProviderFailure('creditExhausted', message, {status});
  if (signal.kind === 'invalid') {
    return status === 403
      ? new ProviderFailure('fatal', message, {status, remediation: MODERATION_REMEDIATION})
      : new ProviderFailure('keyInvalid', message, {status});
  }
  // Only an explicit Retry-After sets the delay; without one the runner backs off exponentially.
  const hinted = retryAfterMs(headers, Date.now());
  if (signal.kind === 'rateLimited') return new ProviderFailure('rateLimited', message, {status, retryAfterMs: hinted});
  if (signal.kind === 'serverError' || status === 408) {
    return new ProviderFailure('unavailable', message, {status, retryAfterMs: hinted});
  }
  if (status === 413 || CONTEXT_TEXT.test(message)) return new ProviderFailure('context', message, {status});
  if (status === 404 || MODEL_TEXT.test(message)) return new ProviderFailure('modelUnavailable', message, {status});
  return new ProviderFailure('fatal', message, {status});
}

/** The typed run error for a provider failure the user has to act on (reconnect, top up). */
export function runErrorCode(error: unknown): RunErrorCode | undefined {
  if (!(error instanceof ProviderFailure)) return undefined;
  if (error.kind === 'keyInvalid') return 'model_key_invalid';
  if (error.kind === 'creditExhausted') return 'model_credit_exhausted';
  return undefined;
}

/** A provider failure inside a tool (the image reader) reported to the model as a tool error. */
export function providerToolError(failure: ProviderFailure): ToolError {
  const base = toolError(failure.kind === 'creditExhausted' ? 'budget' : 'upstream', failure.message);
  return {...base, remediation: failure.remediation};
}
