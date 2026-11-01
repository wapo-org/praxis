import type { GlassDropdownContextValue } from './context';
export function closeAndFocusNext(ctx: GlassDropdownContextValue, backwards: boolean) {
  const trigger = ctx.getTriggerEl();
  const tabbable = Array.from(document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')).filter(el =>
    el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && !ctx.getContentEl()?.contains(el) && !!el.getClientRects().length);
  const index = trigger ? tabbable.indexOf(trigger) : -1;
  const next = tabbable[index + (backwards ? -1 : 1)];
  ctx.setOpen(false);
  (next ?? trigger)?.focus();
}
