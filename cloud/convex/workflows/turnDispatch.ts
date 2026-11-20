import {z} from 'zod';
import {SealedSecret} from '@praxis/types';
import {
  TURN_CURRENT_KEY_ENV, TURN_KEY_MIN_CHARACTERS, TURN_PATH, TURN_REQUEST_TIMEOUT_MS, TURN_SIGNATURE_HEADER,
  TURN_TIMESTAMP_HEADER, TurnRequestSchema, TurnResultSchema, type TurnRequest, type TurnResult,
} from '@praxis/protocol';
import {TURN_WORKER_URL_ENV, WORKFLOW_ERRORS} from './constants.js';

export type WorkerReply =
  | {kind: 'flags'; flags: TurnResult}
  | {kind: 'conflict'}
  | {kind: 'unauthorized'};

const FLAG_KEYS = ['turnIndex', 'done', 'status', 'subagents', 'failure'] as const;
const WorkerPayloadSchema = z.record(z.string(), z.unknown());

function workerConfig(): {url: URL; key: SealedSecret} {
  const origin = process.env[TURN_WORKER_URL_ENV];
  const key = process.env[TURN_CURRENT_KEY_ENV];
  const url = origin && URL.canParse(origin) ? new URL(TURN_PATH, origin) : null;
  if (url?.protocol !== 'https:' || !key || key.trim().length < TURN_KEY_MIN_CHARACTERS) {
    throw new Error(WORKFLOW_ERRORS.unconfigured);
  }
  return {url, key: SealedSecret.of(key)};
}

/** The PRA-38 contract: lowercase hex HMAC-SHA256 over the timestamp, a dot, and the exact body bytes. */
async function signTurn(key: SealedSecret, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const hmac = await crypto.subtle.importKey(
    'raw', encoder.encode(key.reveal()), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', hmac, encoder.encode(`${timestamp}.${body}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Keeps only the flag fields, so the workflow journal never stores worker content. */
function compactFlags(text: string): TurnResult {
  const payload = WorkerPayloadSchema.parse(JSON.parse(text));
  const kept = Object.fromEntries(FLAG_KEYS.filter(key => key in payload).map(key => [key, payload[key]]));
  const extra = Object.keys(payload).length - Object.keys(kept).length;
  if (extra > 0) {
    console.warn(`Turn worker returned ${extra} field(s) beyond flags (${text.length} characters); stripped them`);
  }
  return TurnResultSchema.parse(kept);
}

export async function dispatchTurn(scope: Omit<TurnRequest, 'nonce' | 'decision'>): Promise<WorkerReply> {
  const {url, key} = workerConfig();
  const body = JSON.stringify(TurnRequestSchema.parse({...scope, nonce: crypto.randomUUID()}));
  const timestamp = String(Date.now());
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(TURN_REQUEST_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      [TURN_TIMESTAMP_HEADER]: timestamp,
      [TURN_SIGNATURE_HEADER]: await signTurn(key, timestamp, body),
    },
    body,
  });
  if (response.status === 401) return {kind: 'unauthorized'};
  if (response.status === 409) return {kind: 'conflict'};
  if (!response.ok) throw new Error(`Turn worker returned HTTP ${response.status}`);
  return {kind: 'flags', flags: compactFlags(await response.text())};
}
