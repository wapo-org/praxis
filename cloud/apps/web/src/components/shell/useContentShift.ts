import React from 'react';
import { usePraxisStore } from '../../state/store';

const SIDEBAR_RIGHT = 232 + 12; // --sidebar-width + --float-margin: the docked sidebar's right edge
const COLUMN = 587; // --reading-width: the conversation column, 70ch of the 15 px body serif (WP-L3)
const NARROW = 1024;
const PADDING = 24; // the chat viewport's inline padding (--space-6)

/**
 * How far the centred column moves so it is centred in the area right of the docked sidebar (WP-J2), not on
 * the whole window. Clamped so a column that only just fits keeps its padding from the window's right edge.
 */
export function contentShift(viewport: number, column: number, sidebarOpen: boolean, sidebarRight = SIDEBAR_RIGHT): number {
  if (!sidebarOpen || viewport < NARROW) return 0;
  const width = Math.min(column, viewport - PADDING * 2);
  const centred = sidebarRight / 2;
  const roomRight = (viewport - width) / 2 - PADDING;
  return Math.max(0, Math.min(centred, roomRight));
}

function measuredSidebarRight(): number {
  if (typeof document === 'undefined') return SIDEBAR_RIGHT;
  const style = getComputedStyle(document.documentElement);
  const width = Number.parseFloat(style.getPropertyValue('--sidebar-width'));
  const margin = Number.parseFloat(style.getPropertyValue('--float-margin'));
  return Number.isFinite(width) && Number.isFinite(margin) ? width + margin : SIDEBAR_RIGHT;
}

/**
 * A number for a framer `x` on the column, the header pill and the composer: they glide on the sidebar's own
 * PANEL spring when it opens or closes, instead of reflowing.
 */
export function useContentShift(column = COLUMN): number {
  const { desktopSidebarOpen } = usePraxisStore();
  const [viewport, setViewport] = React.useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const [sidebarRight] = React.useState(measuredSidebarRight);
  React.useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return contentShift(viewport, column, desktopSidebarOpen, sidebarRight);
}
