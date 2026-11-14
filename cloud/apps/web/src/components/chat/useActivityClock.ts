/**
 * Duration formatting, elapsed boundary calculation, and live working timer
 * ported from t3code (`packages/shared/src/orchestrationTiming.ts`,
 * `apps/web/src/components/chat/MessagesTimeline.logic.ts`,
 * `apps/web/src/components/chat/TimelineWorkGroupRows.logic.ts`,
 * `apps/web/src/lib/tickTextContent.ts`).
 *
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */
import React from 'react';

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return '0ms';
  }
  if (durationMs < 1_000) {
    return `${Math.max(1, Math.round(durationMs))}ms`;
  }
  if (durationMs < 10_000) {
    return `${Math.round(durationMs / 100) / 10}s`;
  }

  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(' ');
}

export function computeElapsedMs(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): number | null {
  if (!startIso || !endIso) {
    return null;
  }
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

export function maxIsoTimestamp(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  if (!first) return second ?? null;
  if (!second) return first;
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (Number.isNaN(firstMs) || Number.isNaN(secondMs)) {
    return first > second ? first : second;
  }
  return firstMs >= secondMs ? first : second;
}

/**
 * Resolves the turn start boundary so startup time before run creation (or
 * steered/instant turns where `startedAt` equals `finishedAt`) falls back to
 * the preceding user prompt timestamp when valid.
 */
export function resolveTurnStartIso(
  startedAt?: string,
  finishedAt?: string,
  promptStartedAt?: string,
): string | undefined {
  if (!promptStartedAt) return startedAt;
  const promptMs = Date.parse(promptStartedAt);
  if (Number.isNaN(promptMs)) return startedAt;
  if (!startedAt) return promptStartedAt;
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return promptStartedAt;
  const endMs = finishedAt ? Date.parse(finishedAt) : NaN;
  if (!Number.isNaN(endMs) && promptMs <= endMs && (promptMs < startMs || startMs >= endMs)) {
    return promptStartedAt;
  }
  return startedAt;
}

export function formatWorkingTimer(startedAt: string, nowMs: number): string | null {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatWorkingTimerNow(startedAt: string): string {
  const formatted = formatWorkingTimer(startedAt, Date.now());
  return formatted ? ` · ${formatted}` : '';
}

export function tickTextContent(
  element: HTMLElement | null,
  renderText: () => string,
): () => void {
  if (!element) {
    return () => {};
  }

  let timeoutId: number | null = null;
  const tick = () => {
    element.textContent = renderText();
    timeoutId = window.setTimeout(tick, 1_000 - (Date.now() % 1_000));
  };

  tick();
  return () => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}

export const WorkingTimer = React.memo(function WorkingTimer({ startedAt }: { startedAt: string }) {
  const ref = React.useCallback(
    (node: HTMLSpanElement | null) => tickTextContent(node, () => formatWorkingTimerNow(startedAt)),
    [startedAt],
  );
  return React.createElement('span', { ref, className: 'tabular-nums' });
});

export function workedLabel(startedAt?: string, finishedAt?: string, promptStartedAt?: string) {
  const startIso = resolveTurnStartIso(startedAt, finishedAt, promptStartedAt);
  const elapsedMs = computeElapsedMs(startIso, finishedAt);
  return elapsedMs !== null ? `Worked for ${formatDuration(elapsedMs)}` : 'Worked';
}

export function stoppedLabel(startedAt?: string, finishedAt?: string, promptStartedAt?: string) {
  const startIso = resolveTurnStartIso(startedAt, finishedAt, promptStartedAt);
  const elapsedMs = computeElapsedMs(startIso, finishedAt);
  return elapsedMs !== null ? `Stopped after ${formatDuration(elapsedMs)}` : 'Stopped';
}

export function useActivityClock(
  running: boolean,
  startedAt?: string,
  finishedAt?: string,
  promptStartedAt?: string,
) {
  const [nowIso, setNowIso] = React.useState(() => new Date().toISOString());
  React.useEffect(() => {
    if (!running) return;
    let timeoutId: number | null = null;
    const tick = () => {
      setNowIso(new Date().toISOString());
      timeoutId = window.setTimeout(tick, 1_000 - (Date.now() % 1_000));
    };
    tick();
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [running]);
  return workedLabel(startedAt, running ? nowIso : finishedAt, promptStartedAt);
}
