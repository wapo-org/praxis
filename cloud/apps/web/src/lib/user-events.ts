import { UserEventSchema, type UserEvent } from '@praxis/protocol';
import { PraxisApiError, type PraxisApiClient } from './api';

/**
 * Follows `GET /v1/events` (the user channel: chat/run/... upserts from every client) after `after`.
 * Reconnects with backoff and resumes from the last seen id; a 401 signs out like any other call.
 */
export function subscribeUserEvents(
  client: PraxisApiClient,
  after: number,
  onEvent: (event: UserEvent) => void,
): () => void {
  const controller = new AbortController();
  let cursor = after;
  let stopped = false;
  async function loop() {
    let attempt = 0;
    while (!stopped) {
      try {
        const token = client.getBearerToken();
        const res = await fetch(`${client.getBaseUrl()}/v1/events?after=${cursor}`, {
          credentials: 'include',
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: controller.signal,
        });
        if (res.status === 401) {
          client.onUnauthorized?.();
          return;
        }
        if (!res.ok || !res.body) throw new PraxisApiError(res.status, `sse_${res.status}`, `Events failed (${res.status})`);
        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
            const block = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            let parsed: ReturnType<typeof UserEventSchema.safeParse>;
            try { parsed = UserEventSchema.safeParse(JSON.parse(data)); } catch { continue; }
            if (!parsed.success || parsed.data.id <= cursor) continue;
            cursor = parsed.data.id;
            onEvent(parsed.data);
          }
        }
      } catch {
        if (stopped) return;
      }
      if (stopped) return;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 1.6 ** attempt)));
    }
  }
  void loop();
  return () => {
    stopped = true;
    controller.abort();
  };
}
