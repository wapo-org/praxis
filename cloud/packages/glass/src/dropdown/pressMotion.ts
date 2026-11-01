import { useMotionValue, useSpring, useTransform } from 'framer-motion';
import React from 'react';
import { scrollContainer } from './gestures';
import type { GlassDropdownContextValue } from './context';
export function usePressMotion(
  ctx: GlassDropdownContextValue,
  stretchable: boolean,
  setHighlightedId: (id: string | null) => void,
) {
  const pullX = useMotionValue(0);
  const pullY = useMotionValue(0);
  const springPullX = useSpring(pullX, { stiffness: 420, damping: 26 });
  const springPullY = useSpring(pullY, { stiffness: 420, damping: 26 });
  const stretchScaleY = useTransform(
    springPullY,
    (y) => 1 + Math.min(0.055, Math.abs(y) / 920),
  );
  const pointerDownOriginRef = React.useRef<{ x: number; y: number } | null>(
    null,
  );

  React.useEffect(() => {
    if (!ctx.open) return;
    const handleWindowPointerMove = (e: PointerEvent) => {
      const contentEl = ctx.getContentEl();
      if (!contentEl) return;

      if (ctx.isScrubbing() || pointerDownOriginRef.current) {
        if (typeof document.elementFromPoint === 'function') {
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const itemEl = hit?.closest<HTMLElement>('[data-dropdown-item-id]');
          if (
            itemEl &&
            contentEl.contains(itemEl) &&
            !itemEl.hasAttribute('disabled')
          ) {
            const id = itemEl.getAttribute('data-dropdown-item-id');
            if (id) setHighlightedId(id);
          }
        }
      }

      const nativePan = e.pointerType === 'touch' && !ctx.startedOnTrigger() && scrollContainer(e.target as Element, contentEl);
      if (stretchable && pointerDownOriginRef.current && !nativePan) {
        const dx = e.clientX - pointerDownOriginRef.current.x;
        const dy = e.clientY - pointerDownOriginRef.current.y;
        pullX.set(18 * Math.tanh(dx / (18 * 2.2)));
        pullY.set(48 * Math.tanh(dy / (48 * 2.2)));
      }
    };

    const handleWindowPointerUp = () => {
      pointerDownOriginRef.current = null;
      pullX.set(0);
      pullY.set(0);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, {
      passive: true,
    });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, [ctx, stretchable, pullX, pullY, setHighlightedId]);

  return {
    pullX: springPullX,
    pullY: springPullY,
    stretchScaleY,
    pointerDownOriginRef,
  };
}
