import { MotionConfig } from 'framer-motion';
import React from 'react';
import type { GlassMaterialControls } from '../glass-store';
import type {
  GlassDropdownAlign,
  GlassDropdownContextValue,
  GlassDropdownSide,
  GlassDropdownSubmenuMode,
} from './context';
import {
  assignForwardedRef,
  containsSearch,
  GlassDropdownContext,
} from './context';
import { useMenuReducedMotion } from './motion';
import { usePointerRelease } from './pointer';
export interface GlassDropdownRootProps
  extends React.HTMLAttributes<HTMLDivElement>, GlassMaterialControls {
  portal?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  subPath?: string[];
  defaultSubPath?: string[];
  onSubPathChange?: (path: string[]) => void;
  submenuMode?: GlassDropdownSubmenuMode;
  align?: GlassDropdownAlign;
  side?: GlassDropdownSide;
  sideOffset?: number;
  closeOnSelect?: boolean;
  dismissOnOutsideClick?: boolean;
  children?: React.ReactNode;
}

const GlassDropdownRoot = React.forwardRef<
  HTMLDivElement,
  GlassDropdownRootProps
>(function GlassDropdownRoot(
  {
    portal = false,
    open: controlledOpen,
    defaultOpen = false,
    onOpenChange,
    subPath: controlledSubPath,
    defaultSubPath = [],
    onSubPathChange,
    submenuMode = 'morph',
    align = 'start',
    side = 'auto',
    sideOffset = 8,
    closeOnSelect = true,
    dismissOnOutsideClick = true,
    material = 'regular',
    intensity,
    refraction,
    frost,
    finish,
    backdrop,
    stretchable = true,
    bounce,
    spotlight = true,
    children,
    className = '',
    style,
    ...otherProps
  },
  forwardedRef,
) {
  const reduced = useMenuReducedMotion();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const [subPathState, setSubPathState] =
    React.useState<string[]>(defaultSubPath);
  const activeSubPath =
    controlledSubPath !== undefined ? controlledSubPath : subPathState;
  const [morphDirection, setMorphDirection] = React.useState<1 | -1>(1);

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerElRef = React.useRef<HTMLElement | null>(null);
  const contentElRef = React.useRef<HTMLDivElement | null>(null);
  const scrubbingRef = React.useRef(false);

  const menuId = React.useId();
  const triggerId = React.useId();

  const setRootRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      assignForwardedRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const registerTriggerEl = React.useCallback((el: HTMLElement | null) => {
    triggerElRef.current = el;
  }, []);
  const getTriggerEl = React.useCallback(() => triggerElRef.current, []);
  const registerContentEl = React.useCallback((el: HTMLDivElement | null) => {
    contentElRef.current = el;
  }, []);
  const getContentEl = React.useCallback(() => contentElRef.current, []);
  const focusTrigger = React.useCallback(() => {
    triggerElRef.current?.focus();
  }, []);

  const startScrub = React.useCallback(() => {
    scrubbingRef.current = true;
  }, []);
  const endScrub = React.useCallback(() => {
    scrubbingRef.current = false;
  }, []);
  const isScrubbing = React.useCallback(() => scrubbingRef.current, []);
  const updateSubPath = React.useCallback(
    (nextPath: string[]) => {
      if (controlledSubPath === undefined) {
        setSubPathState(nextPath);
      }
      onSubPathChange?.(nextPath);
    },
    [controlledSubPath, onSubPathChange],
  );

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(next);
      }
      onOpenChange?.(next);
      if (!next) {
        setMorphDirection(-1);
        updateSubPath([]);
      }
    },
    [isControlled, onOpenChange, updateSubPath],
  );

  const pushSub = React.useCallback(
    (depth: number, subId: string) => {
      setMorphDirection(1);
      updateSubPath([...activeSubPath.slice(0, depth), subId]);
    },
    [activeSubPath, updateSubPath],
  );

  const popSub = React.useCallback(
    (toDepth?: number) => {
      setMorphDirection(-1);
      const nextPath =
        toDepth !== undefined
          ? activeSubPath.slice(0, toDepth)
          : activeSubPath.slice(0, Math.max(0, activeSubPath.length - 1));
      updateSubPath(nextPath);
    },
    [activeSubPath, updateSubPath],
  );

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!dismissOnOutsideClick) return;
      const target = event.target as Node | null;
      if (!target || !target.isConnected) return;
      if (
        rootRef.current?.contains(target) ||
        contentElRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, dismissOnOutsideClick, setOpen]);

  usePointerRelease(
    open,
    isScrubbing,
    endScrub,
    getContentEl,
    getTriggerEl,
    setOpen,
  );

  const materialControls = React.useMemo<GlassMaterialControls>(
    () => ({
      material,
      intensity,
      refraction,
      frost,
      finish,
      backdrop,
      stretchable,
      bounce,
      spotlight,
    }),
    [
      material,
      intensity,
      refraction,
      frost,
      finish,
      backdrop,
      stretchable,
      bounce,
      spotlight,
    ],
  );

  const ctxValue = React.useMemo<GlassDropdownContextValue>(
    () => ({
      portal,
      searchable: containsSearch(children),
      open,
      setOpen,
      submenuMode,
      align,
      side,
      sideOffset,
      closeOnSelect,
      materialControls,
      registerTriggerEl,
      getTriggerEl,
      registerContentEl,
      getContentEl,
      focusTrigger,
      menuId,
      triggerId,
      activeSubPath,
      morphDirection,
      pushSub,
      popSub,
      startScrub,
      endScrub,
      isScrubbing,
    }),
    [
      portal,
      children,
      open,
      setOpen,
      submenuMode,
      align,
      side,
      sideOffset,
      closeOnSelect,
      materialControls,
      registerTriggerEl,
      getTriggerEl,
      registerContentEl,
      getContentEl,
      focusTrigger,
      menuId,
      triggerId,
      activeSubPath,
      morphDirection,
      pushSub,
      popSub,
      startScrub,
      endScrub,
      isScrubbing,
    ],
  );

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <GlassDropdownContext.Provider value={ctxValue}>
        <div
          ref={setRootRef}
          data-state={open ? 'open' : 'closed'}
          data-submenu-mode={submenuMode}
          className={`praxis-glass-dropdown ${className}`.trim()}
          style={{
            position: 'relative',
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            ...style,
          }}
          {...otherProps}
        >
          {children}
        </div>
      </GlassDropdownContext.Provider>
    </MotionConfig>
  );
});

export { GlassDropdownRoot };
