import { animate, motion, useMotionValue } from 'framer-motion';
import React from 'react';
import { GLIDE, TRANSITION, useReducedMotion } from './motion';
import styles from './primitives.module.css';

/**
 * One pill that glides between rows instead of each row snapping its own
 * background. Put it first in a `position: relative` list whose rows carry
 * `data-glide`. Layout is read once per row change; the motion itself is
 * transform and opacity, and a move carries the spring's velocity.
 *
 * `active` tracks the current row (selector, re-measured when `activeKey`
 * changes); without it the pill follows the hovered row.
 */
export function GlideHighlight({ active, activeKey, className = '' }: { active?: string; activeKey?: unknown; className?: string }) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const y = useMotionValue(0);
  const opacity = useMotionValue(0);
  const shown = React.useRef(false);
  const reduced = useReducedMotion();

  const moveTo = React.useCallback(
    (row: HTMLElement | null, instant = false) => {
      const el = ref.current;
      if (!el) return;
      if (!row) {
        shown.current = false;
        animate(opacity, 0, TRANSITION.base);
        return;
      }
      el.style.height = `${row.offsetHeight}px`;
      if (!shown.current || reduced || instant) y.set(row.offsetTop);
      else animate(y, row.offsetTop, { ...GLIDE, velocity: y.getVelocity() });
      shown.current = true;
      animate(opacity, 1, TRANSITION.fast);
    },
    [opacity, reduced, y],
  );

  React.useLayoutEffect(() => {
    if (!active) return;
    moveTo(ref.current?.parentElement?.querySelector<HTMLElement>(active) ?? null);
  }, [active, activeKey, moveTo]);

  React.useEffect(() => {
    const list = ref.current?.parentElement;
    if (!list || active) return;
    const over = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const row = (event.target as Element).closest<HTMLElement>('[data-glide]');
      if (row && list.contains(row)) moveTo(row);
    };
    const leave = () => moveTo(null);
    list.addEventListener('pointerover', over);
    list.addEventListener('pointerleave', leave);
    return () => {
      list.removeEventListener('pointerover', over);
      list.removeEventListener('pointerleave', leave);
    };
  }, [active, moveTo]);

  return <motion.span ref={ref} aria-hidden="true" className={`${styles.glide} ${className}`.trim()} style={{ y, opacity }} />;
}
