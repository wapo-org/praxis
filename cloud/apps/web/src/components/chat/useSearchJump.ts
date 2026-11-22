import type { Message } from '@praxis/protocol';
import React from 'react';
import { extractMessageToolSteps } from './messageTools';

export interface SearchJumpTarget {
  chatId: string;
  title?: string;
  query: string;
  snippet?: string;
}

interface PendingJump extends SearchJumpTarget {
  at: number;
  justMounted: boolean;
}

const STOP_WORDS = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or so that the this to was what when where which who why will with you your'.split(
    ' ',
  ),
);

const EXPIRY_MS = 20_000;
const HIGHLIGHT_MS = 1750;
const ENTRANCE_TIMEOUT_MS = 420;
const FOLD_TIMEOUT_MS = 380;

let pendingJump: PendingJump | null = null;
const listeners = new Set<() => void>();

export function extractQueryTerms(query: string): string[] {
  const tokens = query
    .trim()
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter(Boolean);
  const meaningful = tokens.filter((t) => !STOP_WORDS.has(t.toLocaleLowerCase()));
  const base = meaningful.length > 0 ? meaningful : tokens;
  return [...new Set(base)].sort((a, b) => b.length - a.length);
}

export function cleanSnippet(snippet?: string): string {
  if (!snippet) return '';
  return snippet.replace(/^…+|…+$/gu, '').replace(/\s+/gu, ' ').trim();
}

function visibleTextOfMessage(message: Message): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n');
}

function activityTextOfMessage(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === 'reasoning' && part.text) chunks.push(part.text);
    else if (part.type === 'toolCall') {
      if (part.name) chunks.push(part.name);
      if (part.arguments) chunks.push(part.arguments);
    } else if (part.type === 'toolResult') {
      if (part.name) chunks.push(part.name);
      if (part.text) chunks.push(part.text);
      if (part.content) chunks.push(JSON.stringify(part.content));
    }
  }
  for (const step of extractMessageToolSteps(message)) {
    if (step.statusText) chunks.push(step.statusText);
    if (step.argumentsJson) chunks.push(step.argumentsJson);
    if (step.completion?.summary) chunks.push(step.completion.summary);
    if (step.completion?.preview) chunks.push(step.completion.preview);
    if (step.completion?.content) chunks.push(JSON.stringify(step.completion.content));
  }
  return chunks.join('\n');
}

export interface SearchMatchResolution {
  message: Message;
  inActivity: boolean;
  phrase?: string;
}

export function resolveMatchedMessage(
  messages: Message[],
  target: Pick<SearchJumpTarget, 'title' | 'query' | 'snippet'>,
): SearchMatchResolution | null {
  if (!messages.length) return null;
  const query = target.query.trim();
  const lowerQuery = query.toLocaleLowerCase();
  const terms = extractQueryTerms(query);
  const lowerTerms = terms.map((t) => t.toLocaleLowerCase());
  const snippet = cleanSnippet(target.snippet);
  const lowerSnippet = snippet.toLocaleLowerCase();

  const lowerTitle = (target.title ?? '').toLocaleLowerCase();
  const titleHasAllTerms = lowerTerms.length > 0 && lowerTerms.every((t) => lowerTitle.includes(t));

  let best: { resolution: SearchMatchResolution; score: number } | null = null;
  let anyTermMatchedMessage = false;

  for (const message of messages) {
    const visible = visibleTextOfMessage(message);
    const activity = activityTextOfMessage(message);
    const combined = `${visible}\n${activity}`;
    const lowerVisible = visible.toLocaleLowerCase();
    const lowerActivity = activity.toLocaleLowerCase();
    const lowerCombined = combined.toLocaleLowerCase();

    const hitsVisible = lowerTerms.filter((t) => lowerVisible.includes(t)).length;
    const hitsActivity = lowerTerms.filter((t) => lowerActivity.includes(t)).length;
    const hitsCombined = lowerTerms.filter((t) => lowerCombined.includes(t)).length;
    if (hitsCombined > 0) anyTermMatchedMessage = true;

    const snippetMatchesVisible = lowerSnippet.length >= 4 && lowerVisible.replace(/\s+/gu, ' ').includes(lowerSnippet);
    const snippetMatchesActivity =
      lowerSnippet.length >= 4 && lowerActivity.replace(/\s+/gu, ' ').includes(lowerSnippet);

    let score = 0;
    if (lowerQuery && lowerCombined.includes(lowerQuery)) score += 100;
    if (lowerTerms.length > 0 && hitsCombined === lowerTerms.length) score += 50;
    score += hitsCombined * 10;
    if (snippetMatchesVisible || snippetMatchesActivity) score += 25;

    if (score === 0) continue;

    const inActivity = hitsVisible === 0 && !snippetMatchesVisible && (hitsActivity > 0 || snippetMatchesActivity);
    const resolution: SearchMatchResolution = {
      message,
      inActivity,
      phrase:
        snippetMatchesVisible || snippetMatchesActivity
          ? snippet
          : lowerQuery && lowerCombined.includes(lowerQuery)
            ? query
            : undefined,
    };

    if (!best || score > best.score) {
      best = { resolution, score };
    }
  }

  if (!best) return null;
  // Guard against API title-fallback snippet (`texts[0]`) triggering a scroll when only the title matched.
  if (titleHasAllTerms && !anyTermMatchedMessage) return null;
  return best.resolution;
}

export function scheduleSearchJump(target: SearchJumpTarget) {
  pendingJump = {
    ...target,
    at: Date.now(),
    justMounted: listeners.size === 0,
  };
  for (const notify of listeners) notify();
}

export function clearSearchJump() {
  pendingJump = null;
}

function messageElementKey(message: Message): string {
  return message.role === 'user'
    ? `m:${message.clientTurnId ?? message.id}`
    : `r:${message.clientTurnId ?? message.runId ?? message.id}`;
}

function isHiddenOrCollapsed(node: Node, turnEl: HTMLElement): boolean {
  let cur = node.parentElement;
  while (cur && cur !== turnEl) {
    if (cur.hasAttribute('inert') || cur.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(cur);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    cur = cur.parentElement;
  }
  return false;
}

function findMatchedRanges(
  turnEl: HTMLElement,
  terms: string[],
  phrase?: string,
  preferActivity = false,
): Range[] {
  const searchOrder: HTMLElement[] = [];
  if (preferActivity) {
    const steps = turnEl.querySelectorAll<HTMLElement>('[data-testid="agent-activity-view"]');
    for (const el of steps) searchOrder.push(el);
  }
  searchOrder.push(turnEl);

  const candidates: string[] = [];
  if (phrase && phrase.length >= 2) candidates.push(phrase);
  for (const t of terms) {
    if (t.length >= 2 && !candidates.includes(t)) candidates.push(t);
  }
  if (!candidates.length) return [];

  for (const root of searchOrder) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const segments: Array<{ node: Text; start: number; end: number }> = [];
    let full = '';
    let n = walker.nextNode();
    while (n) {
      const textNode = n as Text;
      const val = textNode.nodeValue ?? '';
      if (val && !isHiddenOrCollapsed(textNode, turnEl)) {
        const start = full.length;
        full += val;
        segments.push({ node: textNode, start, end: full.length });
      }
      n = walker.nextNode();
    }
    if (!full) continue;

    const lowerFull = full.toLocaleLowerCase();
    for (const needle of candidates) {
      const lowerNeedle = needle.toLocaleLowerCase();
      const idx = lowerFull.indexOf(lowerNeedle);
      if (idx < 0) continue;

      const matchEnd = idx + needle.length;
      const range = document.createRange();
      const startSeg = segments.find((s) => idx >= s.start && idx < s.end);
      const endSeg = segments.find((s) => matchEnd > s.start && matchEnd <= s.end);
      if (startSeg && endSeg) {
        range.setStart(startSeg.node, idx - startSeg.start);
        range.setEnd(endSeg.node, matchEnd - endSeg.start);
        return [range];
      }
    }
  }
  return [];
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForEntrance(col: HTMLElement, signal: AbortSignal) {
  const start = performance.now();
  while (!signal.aborted && performance.now() - start < ENTRANCE_TIMEOUT_MS) {
    const animating = Array.from(col.querySelectorAll<HTMLElement>(':scope > [data-message-key]')).some(
      (el) => el.style.opacity !== '' || el.style.transform !== '',
    );
    if (!animating) return;
    await nextFrame();
  }
}

async function waitForFolds(turnEl: HTMLElement, signal: AbortSignal) {
  const foldStart = performance.now();
  while (!signal.aborted && performance.now() - foldStart < FOLD_TIMEOUT_MS) {
    const folds = Array.from(turnEl.querySelectorAll<HTMLElement>('[data-open="true"]'));
    if (folds.every((f) => f.dataset.settled === 'true')) break;
    await sleep(32);
  }
}

async function expandActivityIfNeeded(
  turnEl: HTMLElement,
  terms: string[],
  phrase: string | undefined,
  signal: AbortSignal,
) {
  const collapsedMain = Array.from(
    turnEl.querySelectorAll<HTMLButtonElement>('[data-testid="agent-activity-toggle"][aria-expanded="false"]'),
  );
  for (const btn of collapsedMain) btn.click();

  await nextFrame();
  if (signal.aborted) return;

  const stepHeaders = Array.from(
    turnEl.querySelectorAll<HTMLButtonElement>('[data-testid^="tool-step-header-"][aria-expanded="false"]'),
  );
  const thoughtButtons = Array.from(
    turnEl.querySelectorAll<HTMLButtonElement>('[data-testid="agent-activity-steps"] button[aria-expanded="false"]'),
  );
  const needles = [phrase, ...terms].filter((x): x is string => !!x).map((x) => x.toLocaleLowerCase());
  const alreadyVisible = findMatchedRanges(turnEl, terms, phrase, true);
  if (!alreadyVisible.length) {
    for (const btn of [...thoughtButtons, ...stepHeaders]) {
      const rowText = btn.textContent?.toLocaleLowerCase() ?? '';
      if (needles.some((n) => rowText.includes(n)) || stepHeaders.length + thoughtButtons.length <= 4) {
        btn.click();
      }
    }
    if (stepHeaders.length + thoughtButtons.length > 4 && findMatchedRanges(turnEl, terms, phrase, true).length === 0) {
      for (const btn of [...thoughtButtons, ...stepHeaders]) btn.click();
    }
  }

  await nextFrame();
  if (signal.aborted) return;
  await waitForFolds(turnEl, signal);
}

export function useSearchJump(
  scrollRef: React.RefObject<HTMLElement | null>,
  columnRef: React.RefObject<HTMLElement | null>,
  chatId: string | undefined,
  visibleMessages: Message[],
  pendingChatSwitchRef: React.MutableRefObject<string | null>,
) {
  const [bump, setBump] = React.useState(0);
  const activeAbortRef = React.useRef<AbortController | null>(null);
  const cleanupHighlightRef = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const notify = () => setBump((n) => n + 1);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
      activeAbortRef.current?.abort();
      cleanupHighlightRef.current?.();
    };
  }, []);

  React.useLayoutEffect(() => {
    if (!chatId || !pendingJump || pendingJump.chatId !== chatId) return;
    if (Date.now() - pendingJump.at > EXPIRY_MS) {
      pendingJump = null;
      return;
    }
    if (pendingChatSwitchRef.current === chatId || visibleMessages.length === 0) return;

    const target = pendingJump;

    const vp = scrollRef.current;
    const col = columnRef.current;
    if (!vp || !col) return;

    const match = resolveMatchedMessage(visibleMessages, target);
    if (!match) {
      pendingJump = null;
      return;
    }

    const key = messageElementKey(match.message);
    const turnEl = col.querySelector<HTMLElement>(`[data-message-key="${CSS.escape(key)}"]`);
    if (!turnEl) return;

    activeAbortRef.current?.abort();
    cleanupHighlightRef.current?.();

    vp.dispatchEvent(new Event('praxis:hold'));

    const controller = new AbortController();
    activeAbortRef.current = controller;
    const { signal } = controller;

    void (async () => {
      await waitForEntrance(col, signal);
      if (signal.aborted || pendingJump !== target) return;

      vp.dispatchEvent(new Event('praxis:hold'));

      const terms = extractQueryTerms(target.query);
      if (match.inActivity) {
        await expandActivityIfNeeded(turnEl, terms, match.phrase, signal);
        if (signal.aborted || pendingJump !== target) return;
        vp.dispatchEvent(new Event('praxis:hold'));
      }

      // Clear only as we commit so React StrictMode double-mount cleanup or cache->live swaps don't drop it.
      pendingJump = null;

      const ranges = findMatchedRanges(turnEl, terms, match.phrase, match.inActivity);
      const reduced =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const behavior: ScrollBehavior = target.justMounted || reduced ? 'instant' : 'smooth';

      const colRect = col.getBoundingClientRect();
      const vpRect = vp.getBoundingClientRect();
      const vpStyle = getComputedStyle(vp);
      const padTop = parseFloat(vpStyle.paddingTop) || 0;
      const padBottom = parseFloat(vpStyle.paddingBottom) || 0;
      const usableTop = vpRect.top + padTop;
      const usableHeight = Math.max(120, vp.clientHeight - padTop - padBottom);

      const rects: DOMRect[] = [];
      if (ranges.length > 0) {
        for (const r of ranges) {
          for (const cr of Array.from(r.getClientRects())) {
            if (cr.width > 0 && cr.height > 0) rects.push(cr);
          }
        }
      }

      const fallbackSelector = match.inActivity
        ? '[data-testid="agent-activity-steps"], [data-testid="agent-activity-view"], [data-timeline-text]'
        : '[data-user-bubble], [data-timeline-text], [data-testid="agent-activity-view"]';
      const fallbackEl = turnEl.querySelector<HTMLElement>(fallbackSelector) ?? turnEl;
      const focusRect = rects[0] ?? fallbackEl.getBoundingClientRect();
      const focusCenter = focusRect.top + Math.min(focusRect.height, usableHeight * 0.6) / 2;
      const desiredCenter = usableTop + usableHeight / 2;
      const maxScroll = Math.max(0, vp.scrollHeight - vp.clientHeight);
      const nextTop = Math.max(0, Math.min(maxScroll, vp.scrollTop + (focusCenter - desiredCenter)));

      vp.scrollTo({ top: nextTop, behavior });

      const prevColPos = col.style.position;
      if (!prevColPos) col.style.position = 'relative';

      const overlay = document.createElement('div');
      overlay.setAttribute('data-testid', 'search-jump-highlight');
      overlay.setAttribute('data-highlight-kind', rects.length > 0 ? 'text' : 'message');
      overlay.setAttribute('data-scroll-behavior', behavior);
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';

      const boxes = rects.length > 0 ? rects : [fallbackEl.getBoundingClientRect()];
      const padX = rects.length > 0 ? 3 : 4;
      const padY = rects.length > 0 ? 1 : 2;
      const radius = rects.length > 0 ? 5 : 14;
      const bg = rects.length > 0 ? 'rgba(230, 172, 52, 0.28)' : 'rgba(230, 172, 52, 0.14)';

      for (const b of boxes) {
        const mark = document.createElement('span');
        mark.style.cssText =
          `position:absolute;` +
          `left:${(b.left - colRect.left - padX).toFixed(1)}px;` +
          `top:${(b.top - colRect.top - padY).toFixed(1)}px;` +
          `width:${(b.width + padX * 2).toFixed(1)}px;` +
          `height:${(b.height + padY * 2).toFixed(1)}px;` +
          `border-radius:${radius}px;` +
          `background:${bg};`;
        overlay.appendChild(mark);
      }

      col.appendChild(overlay);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        overlay.remove();
        if (!prevColPos && col.style.position === 'relative') {
          col.style.position = '';
        }
        if (cleanupHighlightRef.current === cleanup) cleanupHighlightRef.current = null;
      };
      cleanupHighlightRef.current = cleanup;

      if (!reduced && typeof overlay.animate === 'function') {
        const anim = overlay.animate(
          [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }],
          { duration: HIGHLIGHT_MS, easing: 'ease-out', fill: 'forwards' },
        );
        anim.onfinish = cleanup;
        window.setTimeout(cleanup, HIGHLIGHT_MS + 120);
      } else {
        window.setTimeout(cleanup, HIGHLIGHT_MS);
      }
    })();
  }, [chatId, visibleMessages, pendingChatSwitchRef, scrollRef, columnRef, bump]);
}
