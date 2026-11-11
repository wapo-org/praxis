import { useReducedMotion } from '@praxis/glass';
import React from 'react';
import styles from './RunBackdrop.module.css';

/**
 * A living background while a response generates (WP-K2 item 9): four soft blobs in the sidebar palette's
 * tones orbit on periods with no small common multiple, so the motion never visibly loops. Each blob is a
 * radial gradient (pre-blurred: no filter), and only transforms and the container's opacity animate, so the
 * compositor does all of it. It fades in with generation and out after it, and is absent under reduced motion.
 */
export function RunBackdrop({ active }: { active: boolean }) {
  const reduced = useReducedMotion();
  const [mounted, setMounted] = React.useState(active);
  const [shown, setShown] = React.useState(false);
  if (active && !mounted && !reduced) setMounted(true);
  React.useEffect(() => {
    if (!mounted) return;
    if (!active) {
      setShown(false);
      return;
    }
    // One frame at opacity 0 first, so the fade-in runs from nothing.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    return () => cancelAnimationFrame(id);
  }, [active, mounted]);
  if (!mounted || reduced) return null;
  return (
    <div
      className={styles.backdrop}
      aria-hidden="true"
      data-testid="run-backdrop"
      data-active={active && shown}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'opacity' && !active) setMounted(false);
      }}
    >
      <span className={styles.orbit} data-blob="1"><span className={styles.blob} /></span>
      <span className={styles.orbit} data-blob="2"><span className={styles.blob} /></span>
      <span className={styles.orbit} data-blob="3"><span className={styles.blob} /></span>
      <span className={styles.orbit} data-blob="4"><span className={styles.blob} /></span>
    </div>
  );
}
