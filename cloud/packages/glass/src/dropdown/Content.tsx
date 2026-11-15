import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { GlassSurface } from '../GlassSurface';
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
import { popIn, press, SPRING, TRANSITION } from '../motion';
export interface ContentProps
  extends
    Omit<
      React.HTMLAttributes<HTMLDivElement>,
      'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
    >,
    GlassMaterialControls {
  maxHeight?: number;
  minWidth?: number;
  stretchable?: boolean;
  children?: React.ReactNode;
}

const Content = React.forwardRef<HTMLDivElement, ContentProps>(function Content(
  {
    maxHeight = 380,
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
  const scopeId = React.useId();

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
  const { pullX, pullY, stretchScaleY, pointerDownOriginRef } = usePressMotion(
    ctx,
    stretchable && !reduced,
    setHighlightedId,
  );

  const highlightCtx = React.useMemo<PanelHighlightContextValue>(
    () => ({
      highlightedId,
      setHighlightedId,
      layoutScopeId: `root-${scopeId}-${pathKey}`,
    }),
    [highlightedId, setHighlightedId, scopeId, pathKey],
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
              <motion.div
                ref={setRef}
                transformTemplate={reduced ? () => 'none' : undefined}
                id={ctx.menuId}
                role={ctx.searchable ? undefined : 'menu'}
                tabIndex={-1}
                aria-labelledby={ctx.triggerId}
                onKeyDown={handleKeyDown}
                onPointerDown={(e) => {
                  pointerDownOriginRef.current = { x: e.clientX, y: e.clientY };
                  ctx.startScrub();
                }}
                onPointerLeave={() => {
                  if (!pointerDownOriginRef.current) {
                    setHighlightedId(null);
                  }
                }}
                /* Keep CSS filter off this ancestor: even blur(0) blocks backdrop sampling. */
                initial={reduced ? false : { scale: popIn.initial.scale }}
                animate={{ scale: 1 }}
                exit={reduced ? undefined : { scale: popIn.exit.scale, transition: TRANSITION.fast }}
                transition={reduced ? TRANSITION.none : SPRING}
                className={`praxis-glass-dropdown-content ${styles.content} ${className}`.trim()}
                style={{
                  position: ctx.portal ? 'fixed' : 'absolute',
                  zIndex: 80,
                  minWidth: Math.min(
                    minWidth,
                    typeof window === 'undefined'
                      ? minWidth
                      : window.innerWidth - 16,
                  ),
                  x: reduced ? 0 : pullX,
                  y: reduced ? 0 : pullY,
                  scaleY: reduced ? 1 : stretchScaleY,
                  ...style,
                  ...position,
                }}
                {...otherProps}
              >
                <GlassSurface
                  material={glassMaterial}
                  radius={16}
                  className={styles.surface}
                  initial={reduced ? { opacity: 0 } : { opacity: popIn.initial.opacity }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: TRANSITION.fast }}
                  transition={reduced ? TRANSITION.fast : TRANSITION.base}
                  style={{ overflow: ctx.submenuMode === 'cascade' ? 'visible' : 'hidden' }}
                >
                  <motion.div
                    layout={reduced ? false : 'size'}
                    transition={SPRING}
                    className={styles.sizer}
                  >
                    <AnimatePresence
                      mode="popLayout"
                      initial={false}
                      custom={ctx.morphDirection}
                    >
                      <MorphPanel
                        key={pathKey || '__root__'}
                        data-dropdown-panel={pathKey || '__root__'}
                        custom={ctx.morphDirection}
                        initial={
                          reduced
                            ? false
                            : {
                                opacity: 0,
                                y: ctx.morphDirection > 0 ? 12 : -12,
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
                                y: ctx.morphDirection > 0 ? -12 : 12,
                                scale: press.whileTap.scale,
                                transition: TRANSITION.fast,
                              }
                        }
                        transition={reduced ? TRANSITION.none : SPRING}
                        className={styles.panel}
                      >
                        <MorphHeader level={activeMorphLevel ?? null} />

                        {topPinnedNodes}

                        <ScrollBlur maxHeight={maxHeight} scrimHeight={16}>
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
                  </motion.div>
                </GlassSurface>
              </motion.div>
            </PanelHighlightContext.Provider>
          </DepthContext.Provider>
        ) : null}
      </AnimatePresence>
    </DropdownPortal>
  );
});

export { Content };
