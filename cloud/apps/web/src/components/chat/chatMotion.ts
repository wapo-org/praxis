import { listItem, SPRING, TRANSITION } from '@praxis/glass';
import { animate, cancelFrame, frame } from 'framer-motion';
import React from 'react';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const reduced = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** More keys than this at once is a history load, not an arrival. */
const MAX_ARRIVALS = 3;

export const SEND_FLIGHT_DURATION_MS = 820;
const BUBBLE_RADIUS = 18; /* --bubble-radius */

export interface SendBubblePose extends Box {
  radius: number;
  fillOpacity: number;
  overshoot: number;
}

/**
 * Pure trajectory math for the iMessage-style send animation, calibrated to the
 * 60 fps reference sheets (`IMG_7907`–`IMG_7926`, press at `0 ms`, settled at `820 ms`):
 * - `0..36 ms`: filled bubble materialises over the composer input field (`fromBox`)
 *   with text at the exact input-field coordinates while the field clears behind it.
 * - `40..200 ms`: left edge pulls right rapidly while right edge anchors toward
 *   `toBox.right`, narrowing from full input width to final bubble width.
 * - `40..320 ms`: rises toward `toBox.top`.
 * - `320..480 ms`: overshoots ~4–7 CSS px above `toBox.top`.
 * - `480..820 ms`: drifts gently back down into `toBox.top` with no second bounce.
 */
export function sendBubbleShapeAt(elapsedMs: number, fromBox: Box, toBox: Box): SendBubblePose {
  const t = Math.max(0, elapsedMs);
  const fillOpacity = smoothstep(4, 28, t);

  const uw = Math.max(0, t - 32);
  const w = clamp(Math.max(smoothstep(32, 195, t), 1 - Math.exp(-Math.pow(uw / 48, 1.35))), 0, 1);
  const rightAnchor = smoothstep(32, 180, t);
  const fromRight = fromBox.left + fromBox.width;
  const toRight = toBox.left + toBox.width;
  const right = lerp(fromRight, toRight, rightAnchor);
  const width = lerp(fromBox.width, toBox.width, w);
  const left = right - width;
  const height = lerp(fromBox.height, toBox.height, w);

  const uy = Math.max(0, t - 36);
  const rawRise = 1 - (1 + uy / 68) * Math.exp(-uy / 68);
  const ry = clamp(rawRise + 0.1 * smoothstep(120, 320, t), 0, 1);

  const travel = Math.max(0, fromBox.top - toBox.top);
  const maxOvershoot = travel > 8 ? Math.min(6.5, Math.max(4, travel * 0.04)) : 0;
  const overshoot = maxOvershoot * smoothstep(220, 420, t) * (1 - smoothstep(430, 810, t));
  const top = lerp(fromBox.top, toBox.top, ry) - overshoot;

  const radius = Math.min(BUBBLE_RADIUS, Math.min(width, height) / 2);
  return { left, top, width, height, radius, fillOpacity, overshoot };
}

interface ActiveSendFlight {
  id: number;
  text: string;
  turnKey: string | null;
  existingKeys: Set<string>;
  startTime: number;
  fromBox: Box;
  toBox: Box;
  boundToTarget: boolean;
  shellEl: HTMLDivElement;
  innerEl: HTMLDivElement;
  inputEl: HTMLTextAreaElement | null;
  targetBubbleEl: HTMLElement | null;
  finish: () => void;
}

let nextFlightId = 1;
let activeFlight: ActiveSendFlight | null = null;

function measureNaturalBubbleBox(text: string, fromBox: Box): Box {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;' +
    'max-width:min(78vw,560px);padding:var(--bubble-pad-y) var(--bubble-pad-x);border:1px solid transparent;' +
    'border-radius:var(--bubble-radius);font:var(--bubble-font);' +
    'white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;';
  probe.textContent = text;
  document.body.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const width = Math.max(44, Math.ceil(rect.width) || 64);
  const height = Math.max(36, Math.ceil(rect.height) || 36);
  const right = fromBox.left + fromBox.width;
  return {
    left: right - width,
    top: Math.max(72, fromBox.top - 180),
    width,
    height,
  };
}

function syncFlightTargetBox(flight: ActiveSendFlight) {
  const el = flight.targetBubbleEl;
  if (!el || !el.isConnected) return;
  el.style.visibility = 'hidden';
  el.style.opacity = '0';
  el.dataset.sendInFlight = 'true';
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  flight.toBox = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  flight.shellEl.style.width = `${rect.width}px`;
  flight.shellEl.style.height = `${rect.height}px`;
  flight.innerEl.style.width = `${rect.width}px`;
}

function writeFlightFrame(flight: ActiveSendFlight, elapsedMs: number) {
  const pose = sendBubbleShapeAt(elapsedMs, flight.fromBox, flight.toBox);
  const finalW = Math.max(1, flight.toBox.width);
  const finalH = Math.max(1, flight.toBox.height);
  const sx = Math.max(1e-3, pose.width / finalW);
  const sy = Math.max(1e-3, pose.height / finalH);

  flight.shellEl.style.transform = `translate3d(${pose.left.toFixed(2)}px, ${pose.top.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  flight.shellEl.style.borderRadius = `${(pose.radius / sx).toFixed(2)}px / ${(pose.radius / sy).toFixed(2)}px`;
  flight.shellEl.style.setProperty('--send-fill-opacity', pose.fillOpacity.toFixed(3));
  flight.innerEl.style.transform = `scale(${(1 / sx).toFixed(4)}, ${(1 / sy).toFixed(4)})`;

  if (flight.inputEl && elapsedMs >= 28 && flight.inputEl.dataset.flightLead) {
    delete flight.inputEl.dataset.flightLead;
  }
}

function tickFlight({ timestamp }: { delta: number; timestamp: number }) {
  const flight = activeFlight;
  if (!flight) return;
  const now = typeof performance !== 'undefined' ? performance.now() : timestamp;
  const elapsed = Math.max(0, now - flight.startTime);
  if (elapsed >= SEND_FLIGHT_DURATION_MS) {
    flight.finish();
    return;
  }
  syncFlightTargetBox(flight);
  writeFlightFrame(flight, elapsed);
}

/**
 * Starts the shared-element send flight from the composer textarea before it clears.
 * If an earlier flight is still running, it finishes immediately so its target
 * bubble is never left hidden.
 */
export function launchSendFlight(inputEl: HTMLTextAreaElement | null, text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed || !inputEl || reduced() || typeof document === 'undefined') {
    return null;
  }
  const inputRect = inputEl.getBoundingClientRect();
  if (inputRect.width < 1 || inputRect.height < 1) {
    return null;
  }

  activeFlight?.finish();

  const existingKeys = new Set<string>();
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-key]')) {
    if (node.dataset.messageKey) existingKeys.add(node.dataset.messageKey);
  }

  const fromBox: Box = {
    left: inputRect.left - 12,
    top: inputRect.top - 1,
    width: inputRect.width + 20,
    height: Math.max(36, inputRect.height + 2),
  };
  const toBox = measureNaturalBubbleBox(trimmed, fromBox);

  const shellEl = document.createElement('div');
  shellEl.setAttribute('data-testid', 'send-flight-bubble');
  shellEl.setAttribute('aria-hidden', 'true');
  shellEl.style.cssText =
    `position:fixed;left:0;top:0;z-index:25;pointer-events:none;overflow:hidden;` +
    `width:${toBox.width}px;height:${toBox.height}px;transform-origin:0 0;` +
    `background:color-mix(in srgb, var(--color-bubble) calc(var(--send-fill-opacity, 1) * 100%), transparent);` +
    `box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-line) calc(var(--send-fill-opacity, 1) * 100%), transparent);` +
    `color:var(--color-ink);box-sizing:border-box;will-change:transform;`;

  const innerEl = document.createElement('div');
  innerEl.style.cssText =
    `width:${toBox.width}px;padding:calc(var(--bubble-pad-y) + 1px) calc(var(--bubble-pad-x) + 1px);transform-origin:0 0;` +
    `font:var(--bubble-font);` +
    `white-space:pre-wrap;overflow-wrap:anywhere;box-sizing:border-box;will-change:transform;`;
  innerEl.textContent = trimmed;
  shellEl.appendChild(innerEl);
  document.body.appendChild(shellEl);

  inputEl.dataset.flightLead = 'true';
  const id = nextFlightId++;
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const flight: ActiveSendFlight = {
    id,
    text: trimmed,
    turnKey: null,
    existingKeys,
    startTime,
    fromBox,
    toBox,
    boundToTarget: false,
    shellEl,
    innerEl,
    inputEl,
    targetBubbleEl: null,
    finish() {
      if (activeFlight?.id === id) {
        activeFlight = null;
        cancelFrame(tickFlight);
      }
      if (flight.inputEl?.dataset.flightLead) {
        delete flight.inputEl.dataset.flightLead;
      }
      if (flight.targetBubbleEl) {
        flight.targetBubbleEl.style.visibility = '';
        flight.targetBubbleEl.style.opacity = '';
        delete flight.targetBubbleEl.dataset.sendInFlight;
        flight.targetBubbleEl = null;
      }
      flight.shellEl.remove();
    },
  };

  activeFlight = flight;
  writeFlightFrame(flight, 0);
  frame.update(tickFlight, true);
  return id;
}

export function cancelSendFlight() {
  activeFlight?.finish();
}

export function bindSendFlightTarget(
  bubbleEl: HTMLElement | null,
  turnKey?: string,
  text?: string,
) {
  const flight = activeFlight;
  if (!flight || !bubbleEl) return false;

  if (turnKey !== undefined && text !== undefined) {
    const trimmed = text.trim();
    const matches =
      flight.turnKey === turnKey ||
      (flight.turnKey === null && !flight.existingKeys.has(`m:${turnKey}`) && flight.text === trimmed);
    if (!matches) return false;
    flight.turnKey = turnKey;
  }

  if (flight.targetBubbleEl && flight.targetBubbleEl !== bubbleEl) {
    flight.targetBubbleEl.style.visibility = '';
    flight.targetBubbleEl.style.opacity = '';
    delete flight.targetBubbleEl.dataset.sendInFlight;
  }

  flight.targetBubbleEl = bubbleEl;
  flight.boundToTarget = true;
  bubbleEl.style.visibility = 'hidden';
  bubbleEl.style.opacity = '0';
  bubbleEl.dataset.sendInFlight = 'true';

  syncFlightTargetBox(flight);
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  writeFlightFrame(flight, Math.max(0, now - flight.startTime));
  return true;
}

function currentY(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
}

/**
 * Assistant turns that arrive while you watch rise in on the spring; a loaded
 * history does not. Sent user messages fly from the composer via `launchSendFlight`
 * (with the real bubble hidden until landing and no entry fade), while existing
 * list items glide up smoothly using transform FLIP on the same spring.
 */
export function useMessageArrival(
  column: React.RefObject<HTMLElement | null>,
  chatId: string | undefined,
  keys: string[],
) {
  const seen = React.useRef<{
    chatId: string | undefined;
    keys: Set<string>;
    tops: Map<string, number>;
  } | null>(null);

  React.useLayoutEffect(() => {
    const col = column.current;
    const previous = seen.current;
    const sameChat = !!previous && (previous.chatId === chatId || (!previous.chatId && !!chatId && previous.keys.size === 0));
    const fresh = sameChat ? keys.filter((key) => !previous.keys.has(key)) : [];

    if (col && fresh.some((k) => k.startsWith('m:'))) {
      const viewport = col.closest<HTMLElement>('[data-testid="chat-scroll-viewport"]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }

    const nextTops = new Map<string, number>();
    if (col) {
      for (const child of col.querySelectorAll<HTMLElement>('[data-message-key]')) {
        const key = child.dataset.messageKey;
        if (key) nextTops.set(key, child.getBoundingClientRect().top);
      }
    }

    seen.current = {
      chatId,
      keys: sameChat && previous ? new Set([...previous.keys, ...keys]) : new Set(keys),
      tops: nextTops,
    };

    if (!col) return;

    if (activeFlight) {
      if (!activeFlight.targetBubbleEl || !activeFlight.targetBubbleEl.isConnected) {
        const bubbles = col.querySelectorAll<HTMLElement>('[data-testid="user-message-bubble"] [data-user-bubble]');
        const latestUserBubble = bubbles[bubbles.length - 1] ?? null;
        if (latestUserBubble) {
          bindSendFlightTarget(latestUserBubble);
        }
      } else {
        syncFlightTargetBox(activeFlight);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        writeFlightFrame(activeFlight, Math.max(0, now - activeFlight.startTime));
      }
    }

    if (reduced() || fresh.length === 0 || fresh.length > MAX_ARRIVALS) return;

    // Existing items above a newly added message move up smoothly with the same spring (FLIP).
    if (previous && sameChat && fresh.some((k) => k.startsWith('m:'))) {
      for (const [key, prevTop] of previous.tops.entries()) {
        if (fresh.includes(key)) continue;
        const nextTop = nextTops.get(key);
        if (nextTop === undefined) continue;
        const delta = nextTop - prevTop;
        if (Math.abs(delta) > 1) {
          const el = col.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(key)}"]`);
          if (el) animate(el, { y: [currentY(el) - delta, 0] }, { ...SPRING });
        }
      }
    }

    for (const key of fresh) {
      // User messages never have an entry fade: they stay hidden during send flight and swap in at landing.
      if (key.startsWith('m:')) continue;
      const el = col.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(key)}"]`);
      if (!el) continue;
      animate(el, { opacity: [listItem.initial.opacity ?? 0, 1], y: [listItem.initial.y ?? 0, 0] }, { ...SPRING });
    }
  }, [chatId, column, keys]);
}

/**
 * A disclosure changes height in layout once; what follows it glides there with
 * transforms (FLIP), so opening one never reflows per frame. Starts from wherever
 * the rows are, so toggling mid-flight reverses instead of jumping.
 */
export function glideFollowing(anchor: HTMLElement, delta: number) {
  if (!delta || reduced()) return;
  const column = anchor.closest('[data-chat-column]');
  if (!column) return;
  const limit = window.innerHeight + Math.abs(delta);
  for (let node: Element | null = anchor; node && node !== column; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      const el = next as HTMLElement;
      if (el.getBoundingClientRect().top > limit) return;
      animate(el, { y: [currentY(el) - delta, 0] }, TRANSITION.spring);
    }
  }
}
