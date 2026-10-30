import React from 'react';
import type { GlassDropdownContextValue } from './context';
export const itemSelector = '[data-dropdown-item-id]:not([disabled])';
export function useKeyboard(
  ctx: GlassDropdownContextValue,
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>,
  ready = true,
) {
  const typed = React.useRef({ text: '', at: 0 });
  React.useLayoutEffect(() => {
    if (!ctx.open || !ready) return;
    const menu = ctx.getContentEl();
    const panel =
      Array.from(
        menu?.querySelectorAll<HTMLElement>('[data-dropdown-panel]') ?? [],
      ).find(
        (el) =>
          el.dataset.dropdownPanel ===
          (ctx.activeSubPath.join('/') || '__root__'),
      ) ?? menu;
    (
      panel?.querySelector<HTMLElement>('input') ??
      panel?.querySelector<HTMLElement>(itemSelector) ??
      panel
    )?.focus({ preventScroll: true });
  }, [ready, ctx.open, ctx.activeSubPath.join('/'), ctx.getContentEl]);
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Tab') {
      ctx.setOpen(false);
      return;
    }
    const input = (e.target as HTMLElement).tagName === 'INPUT';
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ctx.activeSubPath.length) ctx.popSub();
      else {
        ctx.setOpen(false);
        ctx.focusTrigger();
      }
      return;
    }
    if (
      !input &&
      ['ArrowLeft', 'Backspace'].includes(e.key) &&
      ctx.activeSubPath.length
    ) {
      e.preventDefault();
      ctx.popSub();
      return;
    }
    const menu = ctx.getContentEl();
    // Virtual lists implement logical navigation before this DOM-based handler.
    const virtual = menu?.querySelector<HTMLElement>('[data-dropdown-virtual]');
    if (
      virtual &&
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(
        e.key,
      ) &&
      (input || virtual.contains(e.target as Node))
    ) {
      e.preventDefault();
      virtual.dispatchEvent(
        new CustomEvent('dropdown-navigate', { detail: e.key }),
      );
      return;
    }
    const items = Array.from(
      menu?.querySelectorAll<HTMLElement>(itemSelector) ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        if (!input) next = 0;
        break;
      case 'End':
        if (!input) next = items.length - 1;
        break;
      case 'PageDown':
        next = Math.min(items.length - 1, index + 5);
        break;
      case 'PageUp':
        next = Math.max(0, index - 5);
        break;
      case ' ':
      case 'Enter':
        if (!input) {
          e.preventDefault();
          (e.target as HTMLElement).click();
        }
        return;
      default:
        if (
          !input &&
          e.key.length === 1 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          const now = Date.now();
          const old = typed.current;
          const text =
            now - old.at < 700
              ? old.text + e.key.toLowerCase()
              : e.key.toLowerCase();
          typed.current = { text, at: now };
          const match = [
            ...items.slice(index + 1),
            ...items.slice(0, index + 1),
          ].find((el) => el.textContent?.trim().toLowerCase().startsWith(text));
          match?.focus();
          e.preventDefault();
        }
    }
    if (next !== undefined) {
      e.preventDefault();
      items[next]?.focus();
    }
  };
}
