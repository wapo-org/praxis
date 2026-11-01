import React from 'react';
import type { GlassDropdownContextValue } from './context';

export function placeMenu(
  trigger: DOMRect,
  width: number,
  height: number,
  vw: number,
  vh: number,
  side: 'top' | 'bottom' | 'auto',
  align: 'start' | 'center' | 'end',
  gap: number,
) {
  const below = vh - trigger.bottom - gap - 8;
  const above = trigger.top - gap - 8;
  let resolved = side === 'auto' ? 'bottom' : side;
  if (
    (resolved === 'bottom' ? below : above) < height &&
    (resolved === 'bottom' ? above > below : below > above)
  )
    resolved = resolved === 'bottom' ? 'top' : 'bottom';
  const available = Math.max(0, resolved === 'bottom' ? below : above);
  const h = Math.min(height, available);
  const w = Math.min(width, vw - 16);
  const ideal =
    align === 'end'
      ? trigger.right - w
      : align === 'center'
        ? trigger.left + (trigger.width - w) / 2
        : trigger.left;
  return {
    left: Math.max(8, Math.min(ideal, vw - 8 - w)),
    top: Math.max(
      8,
      resolved === 'top' ? trigger.top - gap - h : trigger.bottom + gap,
    ),
    width: w,
    maxHeight: available,
    side: resolved,
  };
}

export function usePositioning(
  ctx: GlassDropdownContextValue,
  minWidth: number,
) {
  const [position, setPosition] = React.useState<React.CSSProperties>({
    visibility: 'hidden',
  });
  const [resolvedSide, setSide] = React.useState<'top' | 'bottom'>('bottom');
  React.useLayoutEffect(() => {
    if (!ctx.open) return;
    const menu = ctx.getContentEl();
    const trigger = ctx.getTriggerEl();
    if (!menu || !trigger) return;
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const result = placeMenu(
        rect,
        menu.offsetWidth || minWidth,
        menu.scrollHeight,
        window.innerWidth,
        window.innerHeight,
        ctx.side,
        ctx.align,
        ctx.sideOffset,
      );
      const parent = ctx.portal
        ? undefined
        : menu.offsetParent?.getBoundingClientRect();
      setSide(result.side);
      setPosition({
        left: result.left - (parent?.left ?? 0),
        top: result.top - (parent?.top ?? 0),
        width: result.width,
        maxHeight: result.maxHeight,
        visibility: 'visible',
        transformOrigin: `${rect.left + rect.width / 2 - result.left}px ${result.side === 'top' ? 'bottom' : 'top'}`,
      });
    };
    update();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(menu);
    observer?.observe(trigger);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [
    ctx.portal,
    ctx.open,
    ctx.side,
    ctx.align,
    ctx.sideOffset,
    ctx.activeSubPath.join('/'),
    minWidth,
    ctx.getContentEl,
    ctx.getTriggerEl,
  ]);
  return { position, resolvedSide };
}
