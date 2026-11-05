import React from 'react';
import { usePraxisStore } from '../../state/store';

const SIDEBAR_CLEAR = 260 + 12 * 2 + 24; // --sidebar-width + margins + breathing room
const COLUMN = 720; // --column-width
const NARROW = 1024;

/** How far a centred column must move so the floating sidebar never covers it. */
export function contentShift(viewport: number, column: number, sidebarOpen: boolean): number {
  if (!sidebarOpen || viewport < NARROW) return 0;
  const width = Math.min(column, viewport - SIDEBAR_CLEAR - 24);
  return Math.max(0, SIDEBAR_CLEAR - (viewport - width) / 2);
}

/**
 * The content stays centred in the window, where it passes behind nothing, and
 * only moves on a window too small to fit it beside the sidebar. A number for a
 * framer `x`, so the column glides with the sidebar instead of reflowing.
 */
export function useContentShift(column = COLUMN): number {
  const { desktopSidebarOpen } = usePraxisStore();
  const [viewport, setViewport] = React.useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  React.useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return contentShift(viewport, column, desktopSidebarOpen);
}
