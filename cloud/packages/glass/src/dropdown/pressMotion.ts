import React from 'react';
import type { GlassDropdownContextValue } from './context';

export function usePressMotion(ctx: GlassDropdownContextValue, setHighlightedId: (id: string | null) => void) {
  const pointerDownOriginRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!ctx.open) return;
    const handleWindowPointerMove = (e: PointerEvent) => {
      const contentEl = ctx.getContentEl();
      if (!contentEl) return;
      if ((ctx.isScrubbing() || pointerDownOriginRef.current) && typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const itemEl = hit?.closest<HTMLElement>('[data-dropdown-item-id]');
        if (itemEl && contentEl.contains(itemEl) && !itemEl.hasAttribute('disabled')) {
          const id = itemEl.getAttribute('data-dropdown-item-id');
          if (id) setHighlightedId(id);
        }
      }
    };
    const handleWindowPointerUp = () => {
      pointerDownOriginRef.current = null;
    };
    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, [ctx, setHighlightedId]);

  return { pointerDownOriginRef };
}
