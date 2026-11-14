import React from 'react';
import styles from './Fold.module.css';

/**
 * One disclosure motion for every activity row (Reasoned for, Worked for, tool rows).
 * The height (grid 0fr → 1fr), the content's fade and the chevron's turn are three CSS transitions on the
 * same duration and curve (--fold-duration, --fold-ease), started by the same attribute change, so nothing
 * arrives early or late. What follows the fold moves with its height because it is in the flow below it.
 * Reverses from wherever it is. Content mounts on open and unmounts only once a close has finished.
 */
export function Fold({
  open,
  id,
  testId,
  className = '',
  children,
}: {
  open: boolean;
  id?: string;
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(open);
  const [settled, setSettled] = React.useState(open);
  if (open && !mounted) setMounted(true);
  if (settled && !open) setSettled(false);
  const finish = React.useCallback(() => {
    if (open) setSettled(true);
    else setMounted(false);
  }, [open]);
  const onEnd = (event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows') finish();
  };
  // No transition will run (reduced motion, or no styles at all): settle in the same commit.
  React.useEffect(() => {
    const el = ref.current;
    const seconds = el ? Math.max(...getComputedStyle(el).transitionDuration.split(',').map((v) => Number.parseFloat(v) || 0)) : 0;
    if (!(seconds > 0)) finish();
  }, [finish]);
  return (
    <div
      ref={ref}
      className={`${styles.fold} ${className}`.trim()}
      data-open={open}
      data-settled={open && settled}
      data-testid={testId}
      onTransitionEnd={onEnd}
    >
      <div className={styles.clip} id={id} inert={!open}>
        {mounted ? children : null}
      </div>
    </div>
  );
}

/** Tells the chat's scroll follower that the user opened something: stop pinning to the latest line. */
export function holdScrollPosition(from: Element | null) {
  from?.closest('[data-testid="chat-scroll-viewport"]')?.dispatchEvent(new Event('praxis:hold'));
}
