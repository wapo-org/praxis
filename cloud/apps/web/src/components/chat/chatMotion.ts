import { listItem, SPRING, TRANSITION } from '@praxis/glass';
import { animate } from 'framer-motion';
import React from 'react';

const reduced = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** More keys than this at once is a history load, not an arrival. */
const MAX_ARRIVALS = 3;

/**
 * Messages that arrive while you watch rise in on the spring; a loaded history
 * does not. Imperative, so the 200 rows in a long chat stay plain divs. A run's
 * live turn and its saved message share a key, so the swap never animates twice.
 */
export function useMessageArrival(column: React.RefObject<HTMLElement | null>, chatId: string | undefined, keys: string[]) {
  const seen = React.useRef<{ chatId: string | undefined; keys: Set<string> } | null>(null);
  React.useLayoutEffect(() => {
    const previous = seen.current;
    const fresh = previous && previous.chatId === chatId ? keys.filter((key) => !previous.keys.has(key)) : [];
    seen.current = {
      chatId,
      keys: previous && previous.chatId === chatId ? new Set([...previous.keys, ...keys]) : new Set(keys),
    };
    if (reduced() || fresh.length === 0 || fresh.length > MAX_ARRIVALS || !column.current) return;
    for (const key of fresh) {
      const el = column.current.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(key)}"]`);
      if (el) animate(el, { opacity: [listItem.initial.opacity ?? 0, 1], y: [listItem.initial.y ?? 0, 0] }, { ...SPRING });
    }
  }, [chatId, column, keys]);
}

function currentY(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  return transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
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
