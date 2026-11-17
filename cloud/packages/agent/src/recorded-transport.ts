import {readFileSync} from 'node:fs';
import {JsonObjectSchema, type JsonObject} from '@praxis/protocol';

// Fixtures follow OpenRouter's documented stream shape but were written by hand, not captured from a live call.
export interface RecordedCall {
  url: string;
  headers: Headers;
  body: JsonObject;
}
export type CannedResponse = string | {status: number; body: unknown; headers?: Record<string, string>};

/** Byte size each replayed body is cut into, so frames and UTF-8 sequences straddle reads as they do on a socket. */
const REPLAY_CHUNK_BYTES = 37;

export function recording(name: string): string {
  return readFileSync(new URL(`./fixtures/openrouter/${name}`, import.meta.url), 'utf8');
}

/** Replays canned OpenRouter responses in order and keeps every request it was sent. */
export function recordedTransport(...responses: CannedResponse[]): {fetcher: typeof fetch; calls: RecordedCall[]} {
  const calls: RecordedCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JsonObjectSchema.parse(JSON.parse(String(init?.body))),
    });
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`No canned response for request ${calls.length}`);
    if (typeof next === 'string') {
      return new Response(chunked(next), {headers: {'content-type': 'text/event-stream'}});
    }
    return Response.json(next.body, {status: next.status, headers: next.headers ?? {}});
  }) as typeof fetch;
  return {fetcher, calls};
}

function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += REPLAY_CHUNK_BYTES) {
        controller.enqueue(bytes.slice(offset, offset + REPLAY_CHUNK_BYTES));
      }
      controller.close();
    },
  });
}
