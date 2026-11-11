import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { GlassMorph } from '../morph/GlassMorph';
import { ScrollBlur } from '../ProgressiveBlurScrim';
import type { GlassMaterialControls } from '../GlassSurface';
import styles from './dropdown.module.css';
import { MorphPanel } from './MorphPanel';
import { MorphRows } from './MorphRows';
import { MorphHeader } from './MorphHeader';
import { DropdownPortal } from './Portal';
import type { PanelHighlightContextValue, SubLevelInfo } from './context';
import {
  ACTION_GRID_MARKER,
  assignForwardedRef,
  DepthContext,
  PanelHighlightContext,
  SEARCH_MARKER,
  useGlassDropdownContext,
} from './context';
import { useKeyboard } from './keyboard';
import { resolveMorphTrail } from './morph';
import { useMenuReducedMotion } from './motion';
import { usePositioning } from './positioning';
import { usePressMotion } from './pressMotion';
import { MORPH, press, TRANSITION } from '../motion';

export interface ContentProps
  extends
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
    >,
    GlassMaterialControls {
  maxHeight?: number;
  minWidth?: number;
  /** The glass stretches toward a pointer dragged past its edge while scrubbing. */
  stretchable?: boolean;
  children?: React.ReactNode;
}

const Content = React.forwardRef<HTMLDivElement, ContentProps>(function Content(
  {
    maxHeight = Number.MAX_SAFE_INTEGER,
    minWidth = 240,
    children,
    className = '',
    material,
    stretchable = true,
    onKeyDown,
    style,
    ...otherProps
  },
  forwardedRef,
) {
  const ctx = useGlassDropdownContext('Content');
  const pathKey = ctx.activeSubPath.join('/');
  const [highlightState, setHighlightState] = React.useState<{
    key: string;
    id: string | null;
  }>({
    key: pathKey,
    id: null,
  });

  const highlightedId =
    highlightState.key === pathKey ? highlightState.id : null;
  const setHighlightedId = React.useCallback(
    (id: string | null) => setHighlightState({ key: pathKey, id }),
    [pathKey],
  );

  const setRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      ctx.registerContentEl(node);
      assignForwardedRef(forwardedRef, node);
    },
    [ctx, forwardedRef],
  );

  const { position, resolvedSide } = usePositioning(ctx, minWidth);
  const handleKeyDown = useKeyboard(
    ctx,
    onKeyDown,
    position.visibility !== 'hidden',
  );
  const reduced = useMenuReducedMotion();
  const { pointerDownOriginRef } = usePressMotion(ctx, setHighlightedId);

  const highlightCtx = React.useMemo<PanelHighlightContextValue>(
    () => ({
      highlightedId,
      setHighlightedId,
    }),
    [highlightedId, setHighlightedId],
  );

  const glassMaterial = material ?? ctx.materialControls.material ?? 'thick';

  const morphState = React.useMemo(() => {
    if (ctx.submenuMode !== 'morph' || ctx.activeSubPath.length === 0) {
      return { trail: [] as SubLevelInfo[], activeChildren: children };
    }
    return resolveMorphTrail(children, ctx.activeSubPath);
  }, [ctx.submenuMode, ctx.activeSubPath, children]);

  const activeMorphLevel =
    morphState.trail.length > 0
      ? morphState.trail[morphState.trail.length - 1]
      : null;

  // Separate top sticky ActionGrid / Search from scrollable list when at root level
  const topPinnedNodes: React.ReactNode[] = [];
  const scrollableNodes: React.ReactNode[] = [];

  React.Children.forEach(morphState.activeChildren, (child) => {
    if (
      !activeMorphLevel &&
      React.isValidElement(child) &&
      ((child.type as { [ACTION_GRID_MARKER]?: boolean })?.[
        ACTION_GRID_MARKER
      ] ||
        (child.type as { [SEARCH_MARKER]?: boolean })?.[SEARCH_MARKER])
    ) {
      topPinnedNodes.push(child);
    } else {
      scrollableNodes.push(child);
    }
  });

  return (
    <DropdownPortal enabled={ctx.portal}>
      <AnimatePresence>
        {ctx.open ? (
          <DepthContext.Provider value={0}>
            <PanelHighlightContext.Provider value={highlightCtx}>
              <GlassMorph
                source={ctx.getTriggerEl}
                ready={position.visibility !== 'hidden'}
                shellRef={setRef}
                shellProps={{
                  ...otherProps,
                  id: ctx.menuId,
                  role: ctx.searchable ? undefined : 'menu',
                  tabIndex: -1,
                  'aria-labelledby': ctx.triggerId,
                  onKeyDown: handleKeyDown,
                  onPointerDown: (e) => {
                    pointerDownOriginRef.current = { x: e.clientX, y: e.clientY };
                    ctx.startScrub();
                  },
                  onPointerLeave: () => {
                    if (!pointerDownOriginRef.current) {
                      setHighlightedId(null);
                    }
                  },
                  className: `praxis-glass-dropdown-content ${styles.content} ${className}`.trim(),
                  style: {
                    position: ctx.portal ? 'fixed' : 'absolute',
                    zIndex: 80,
                    // The cap wins over any caller's minWidth; long labels truncate.
                    minWidth: `min(${minWidth}px, var(--menu-max-width), calc(100vw - var(--space-4)))`,
                    ...style,
                    ...position,
                  },
                }}
                material={glassMaterial}
                stretch={stretchable ? 'edge' : false}
                className={styles.surface}
                style={{ overflow: ctx.submenuMode === 'cascade' ? 'visible' : 'hidden' }}
              >
                  {/* The height is the engine's: GlassMorph glides the glass to the new size in transforms. */}
                  <div className={styles.sizer}>
                    <AnimatePresence
                      mode="popLayout"
                      initial={false}
                      custom={ctx.morphDirection}
                    >
                      <MorphPanel
                        key={ctx.submenuMode === 'cascade' ? '__root__' : pathKey || '__root__'}
                        data-dropdown-panel={pathKey || '__root__'}
                        custom={ctx.morphDirection}
                        initial={
                          reduced
                            ? false
                            : {
                                opacity: 0,
                                y: ctx.morphDirection > 0 ? 10 : -10,
                                scale: press.whileTap.scale,
                              }
                        }
                        animate={{
                          opacity: 1,
                          y: 0,
                          scale: 1,
                        }}
                        exit={
                          reduced
                            ? { opacity: 0 }
                            : {
                                opacity: 0,
                                y: ctx.morphDirection > 0 ? -10 : 10,
                                scale: press.whileTap.scale,
                                transition: TRANSITION.fast,
                              }
                        }
                        transition={reduced ? TRANSITION.none : { ...TRANSITION.base, opacity: { ...TRANSITION.base, delay: MORPH.panelFadeDelay } }}
                        className={styles.panel}
                      >
                        {/* Elevated Submenu Sticky Header (IMG_7773–IMG_7774: "Recent Notes ⌄") */}
                        <MorphHeader level={activeMorphLevel ?? null} />

                        {/* Top pinned ActionGrid & Search */}
                        {topPinnedNodes}

                        {/* Scrollable items with progressive blur edge scrims */}
                        <ScrollBlur maxHeight={`min(${maxHeight}px, var(--menu-list-height, calc(100vh - 32px)))`} scrimHeight={16} open={ctx.submenuMode === 'cascade'}>
                          <DepthContext.Provider
                            value={morphState.trail.length}
                          >
                            <div
                              id={
                                ctx.searchable
                                  ? `${ctx.menuId}-listbox`
                                  : undefined
                              }
                              role={ctx.searchable ? 'listbox' : undefined}
                              aria-labelledby={
                                ctx.searchable ? ctx.triggerId : undefined
                              }
                              className={styles.list}
                            >
                              <MorphRows stagger={!!activeMorphLevel} reduced={reduced}>{scrollableNodes}</MorphRows>
                            </div>
                          </DepthContext.Provider>
                        </ScrollBlur>
                      </MorphPanel>
                    </AnimatePresence>
                  </div>
              </GlassMorph>
            </PanelHighlightContext.Provider>
          </DepthContext.Provider>
        ) : null}
      </AnimatePresence>
    </DropdownPortal>
  );
});

export { Content };
