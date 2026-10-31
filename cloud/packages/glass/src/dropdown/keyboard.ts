import React from 'react';
import { closeAndFocusNext } from './focus';
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
    const returning = ctx.takeReturningSub();
    const parent = Array.from(panel?.querySelectorAll<HTMLElement>('[data-dropdown-sub-id]') ?? []).find(el => el.dataset.dropdownSubId === returning);
    if (parent) { parent.focus({ preventScroll: true }); return; }
    if (ctx.pointerOpening.current && !ctx.activeSubPath.length && !panel?.querySelector('input')) return;
    (
      panel?.querySelector<HTMLElement>('input') ??
      panel?.querySelector<HTMLElement>(itemSelector) ??
      panel
    )?.focus({ preventScroll: true });
  }, [ready, ctx.open, ctx.activeSubPath.join('/'), ctx.getContentEl]);
  return (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    ctx.pointerOpening.current = false;
    if (e.key === 'Tab') {
      e.preventDefault();
      closeAndFocusNext(ctx, e.shiftKey);
      return;
    }
    const input = (e.target as HTMLElement).tagName === 'INPUT';
    const grid = (e.target as HTMLElement).closest('[data-slot="dropdown-action-grid"]');
    if (grid && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      const tiles = Array.from(grid.querySelectorAll<HTMLElement>(itemSelector));
      const index = tiles.indexOf(document.activeElement as HTMLElement);
      e.preventDefault(); e.stopPropagation();
      tiles[(index + (e.key === 'ArrowRight' ? 1 : -1) + tiles.length) % tiles.length]?.focus();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
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
      e.stopPropagation();
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
    const panel = Array.from(menu?.querySelectorAll<HTMLElement>('[data-dropdown-panel]') ?? [])
      .find(el => el.dataset.dropdownPanel === (ctx.activeSubPath.join('/') || '__root__')) ?? menu;
    const items = Array.from(panel?.querySelectorAll<HTMLElement>(itemSelector) ?? [])
      .filter(el => !el.closest('[inert]'));
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
