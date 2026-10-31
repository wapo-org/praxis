import { RunEventSchema, type RunEvent, type RunSnapshot } from '@praxis/protocol';
import { PraxisApiClient, PraxisApiError } from './api';
import { safeMessage } from './links';

export interface RunStreamHandlers {
  onEvent: (event: RunEvent) => void;
  onSnapshotRecovered?: (snapshot: RunSnapshot) => void;
  onError?: (err: unknown) => void;
  onComplete?: () => void;
}

/**
 * Connects to `GET /v1/runs/:id/events` using fetch streaming with:
 * - `Authorization: Bearer <token>`
 * - `Last-Event-ID: <cursor>`
 * - Automatic 409 `cursor_expired` recovery via `GET /v1/runs/:id/snapshot`
 * - Automatic reconnect with backoff on transient network drops
 * - Performance marks (`praxis:sse-first-token`)
 */
export function subscribeRunEvents(
  client: PraxisApiClient,
  runId: string,
  initialAfterEventId: number,
  handlers: RunStreamHandlers,
): () => void {
  const controller = new AbortController();
  let lastEventId = initialAfterEventId;
  let stopped = false;
  let markedFirstToken = false;
  const seenIds = new Set<number>();

  async function loop() {
    let attempt = 0;
    while (!stopped && !controller.signal.aborted) {
      try {
        const base = client.getBaseUrl();
        const url = `${base}/v1/runs/${encodeURIComponent(runId)}/events?after=${lastEventId}`;
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'text/event-stream',
            ...(client.getBearerToken()
              ? { Authorization: `Bearer ${client.getBearerToken()}` }
              : {}),
            'Last-Event-ID': String(lastEventId),
          },
          signal: controller.signal,
        });

        if (res.status === 401) {
          client.onUnauthorized?.();
          return;
        }
        if (res.status === 409) {
          // Cursor expired: recover authoritative snapshot and resume after snapshot.lastEventId
          const snapshot = await client.getRunSnapshot(runId);
          lastEventId = snapshot.lastEventId;
          handlers.onSnapshotRecovered?.(snapshot);
          if (['completed', 'cancelled', 'failed'].includes(snapshot.run.status)) {
            handlers.onComplete?.();
            return;
          }
          continue;
        }

        if (!res.ok || !res.body) {
          throw new PraxisApiError(res.status, `sse_${res.status}`, `SSE failed (${res.status})`);
        }

        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!stopped && !controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
            const rawBlock = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);

            const lines = rawBlock.split(/\r?\n/);
            let dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }

            if (dataLines.length > 0) {
              const jsonStr = dataLines.join('\n');
              try {
                const parsed = parseRunEvent(JSON.parse(jsonStr));
                if (parsed && parsed.type === 'run.event' && typeof parsed.id === 'number') {
                  if (!seenIds.has(parsed.id)) {
                    seenIds.add(parsed.id);
                    lastEventId = Math.max(lastEventId, parsed.id);

                    if (
                      !markedFirstToken &&
                      (parsed.event.type === 'text.delta' ||
                        parsed.event.type === 'reasoning.delta')
                    ) {
                      markedFirstToken = true;
                      if (typeof performance !== 'undefined') {
                        performance.mark('praxis:sse-first-token');
                      }
                    }

                    handlers.onEvent(parsed);
                    if (parsed.event.type === 'run.finished') {
                      stopped = true;
                      handlers.onComplete?.();
                      return;
                    }
                  }
                }
              } catch {
                // Ignore malformed keepalive or partial lines
              }
            }
          }
        }

        // Stream closed cleanly; check if run is terminal
        const run = await client.getRun(runId);
        if (
          ['completed', 'cancelled', 'failed'].includes(run.status) &&
          lastEventId >= run.lastEventId
        ) {
          stopped = true;
          handlers.onComplete?.();
          return;
        }
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        handlers.onError?.(err);
        attempt += 1;
        const delay = Math.min(2000, 150 * Math.pow(1.6, attempt));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  void loop();

  return () => {
    stopped = true;
    controller.abort();
  };
}

export function parseRunEvent(value: unknown): RunEvent | null {
  const result = RunEventSchema.safeParse(value);
  if (result.success)
    return result.data.event.type === 'messages.committed'
      ? {
          ...result.data,
          event: {
            ...result.data.event,
            messages: result.data.event.messages.map(safeMessage),
          },
        }
      : result.data;
  if (import.meta.env.DEV) console.warn('Dropped invalid or unknown run event');
  return null;
}
