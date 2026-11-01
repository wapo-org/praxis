import { motion } from 'framer-motion';
import { ChevronDown } from '../icons';
import React from 'react';
import { closeAndFocusNext } from './focus';
import { GlassSurface } from '../GlassSurface';
import type { GlassMaterialControls } from '../GlassSurface';
import { assignForwardedRef, useGlassDropdownContext } from './context';
import { useMenuReducedMotion } from './motion';
import { press, SPRING, TRANSITION } from '../motion';
export interface TriggerProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'>,
    GlassMaterialControls {
  icon?: React.ReactNode;
  value?: React.ReactNode;
  hideChevron?: boolean;
  asChild?: boolean;
  children?: React.ReactNode;
}

const Trigger = React.forwardRef<HTMLButtonElement, TriggerProps>(
  function Trigger(
    {
      icon,
      value,
      hideChevron = false,
      asChild = false,
      children,
      className = '',
      material,
      onClick,
      onPointerDown,
      onKeyDown,
      style,
      ...otherProps
    },
    forwardedRef,
  ) {
    const ctx = useGlassDropdownContext('Trigger');
    const pointerOpened = React.useRef(false);
    const reduced = useMenuReducedMotion();

    const setRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        ctx.registerTriggerEl(node);
        assignForwardedRef(forwardedRef, node);
      },
      [ctx, forwardedRef],
    );

    const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(e);
      if (e.defaultPrevented || otherProps.disabled || e.button !== 0) return;
      e.preventDefault();
      ctx.focusTrigger();
      pointerOpened.current = !ctx.open;
      ctx.startScrub('trigger');
      ctx.setOpen(true);
    };

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (e.defaultPrevented) return;
      ctx.endScrub();
      if (!pointerOpened.current) ctx.setOpen(!ctx.open);
      pointerOpened.current = false;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      ctx.pointerOpening.current = false;
      if (e.key === 'Tab' && ctx.open) { e.preventDefault(); closeAndFocusNext(ctx, e.shiftKey); return; }
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ctx.endScrub();
        ctx.setOpen(true);
        const focusFirst = () => {
          const menu = ctx.getContentEl();
          if (menu?.contains(document.activeElement) && !document.activeElement?.closest('[inert]')) return;
          (menu?.querySelector<HTMLElement>('input, [data-dropdown-item-id]:not([disabled])') ?? menu)?.focus({ preventScroll: true });
        };
        if (ctx.open) focusFirst(); else requestAnimationFrame(focusFirst);
      } else if (e.key === 'Escape' && ctx.open) {
        e.preventDefault();
        if (ctx.activeSubPath.length) ctx.popSub(); else ctx.setOpen(false);
      }
    };

    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(
        children as React.ReactElement<Record<string, unknown>>,
        {
          style: {
            touchAction: 'none',
            ...(children.props as { style?: React.CSSProperties }).style,
            ...style,
          },
          ref: setRef,
          id: ctx.triggerId,
          'aria-haspopup': ctx.searchable ? 'listbox' : 'menu',
          'aria-expanded': ctx.open,
          'aria-controls': ctx.open ? ctx.menuId : undefined,
          'data-state': ctx.open ? 'open' : 'closed',
          onPointerDown: handlePointerDown,
          onClick: handleClick,
          onKeyDown: handleKeyDown,
        },
      );
    }

    return (
      <motion.div
        animate={{ scale: !reduced && ctx.open ? press.whileTap.scale : 1 }}
        transition={reduced ? TRANSITION.none : SPRING}
        style={{ display: 'inline-flex', maxWidth: '100%' }}
      >
        <GlassSurface
          shape="capsule"
          material={material ?? ctx.materialControls.material ?? 'regular'}
          className={className}
          style={{ display: 'inline-flex', maxWidth: '100%' }}
        >
          <button
            ref={setRef}
            id={ctx.triggerId}
            type="button"
            aria-haspopup={ctx.searchable ? 'listbox' : 'menu'}
            aria-expanded={ctx.open}
            aria-controls={ctx.open ? ctx.menuId : undefined}
            data-state={ctx.open ? 'open' : 'closed'}
            onPointerDown={handlePointerDown}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              padding: '7px 13px',
              borderRadius: '9999px',
              border: 'none',
              background: ctx.open ? 'rgba(21,20,15,0.06)' : 'transparent',
              color: 'var(--paper-ink)',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              fontWeight: 600,
              lineHeight: '16px',
              cursor: 'pointer',
              userSelect: 'none',
              touchAction: 'none',
              outline: 'none',
              ...style,
            }}
            {...otherProps}
          >
            {icon ? (
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-flex',
                  color: 'var(--paper-secondary-ink)',
                }}
              >
                {icon}
              </span>
            ) : null}
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {children}
            </span>
            {value !== undefined && value !== null ? (
              <span
                style={{
                  borderRadius: '9999px',
                  background: 'var(--paper-fill-2)',
                  padding: '2px 8px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11px',
                  fontWeight: 500,
                  color: 'var(--paper-secondary-ink)',
                }}
              >
                {value}
              </span>
            ) : null}
            {!hideChevron ? (
              <ChevronDown
                aria-hidden="true"
                size={16}
                style={{
                  color: 'var(--paper-muted-ink)',
                  transform: ctx.open ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform var(--duration-base) var(--ease-standard)',
                }}
              />
            ) : null}
          </button>
        </GlassSurface>
      </motion.div>
    );
  },
);

export { Trigger };
