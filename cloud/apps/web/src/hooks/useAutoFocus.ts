import React from 'react';

/** Focuses the element once it mounts, without scrolling it into view (the tray animates in from below). */
export function useAutoFocus(ref: React.RefObject<HTMLElement | null>, enabled: boolean): void {
  React.useLayoutEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: true });
  }, [enabled, ref]);
}
