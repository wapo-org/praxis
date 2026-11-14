import { motion } from 'framer-motion';
import { ChevronDown } from '../icons';
import React from 'react';
import { closeAndFocusNext } from './focus';
import { GlassSurface } from '../GlassSurface';
import type { GlassMaterialControls } from '../GlassSurface';
import { assignForwardedRef, useGlassDropdownContext } from './context';
import styles from './dropdown.module.css';
import { useMenuReducedMotion } from './motion';
import { SNAP, TRANSITION } from '../motion';
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
    const childProps = asChild && React.isValidElement(children)
      ? (children.props as Record<string, unknown>)
      : null;
    const isDisabled = Boolean(otherProps.disabled || childProps?.disabled);

    const setRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        ctx.registerTriggerEl(node);
        assignForwardedRef(forwardedRef, node);
      },
      [ctx, forwardedRef],
    );

    const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
      onPointerDown?.(e);
      if (e.defaultPrevented || isDisabled || e.button !== 0) return;
      e.preventDefault();
      ctx.focusTrigger();
      pointerOpened.current = !ctx.open;
      ctx.startScrub('trigger');
      ctx.setOpen(true);
    };

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || isDisabled) return;
      ctx.endScrub();
      if (!pointerOpened.current) ctx.setOpen(!ctx.open);
      pointerOpened.current = false;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented || isDisabled) return;
      ctx.pointerOpening.current = false;
      if (e.key === 'Tab' && ctx.open) { e.preventDefault(); closeAndFocusNext(ctx, e.shiftKey); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
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
        e.stopPropagation();
        if (ctx.activeSubPath.length) ctx.popSub(); else ctx.setOpen(false);
      }
    };

    if (asChild && React.isValidElement(children)) {
      const childRef = childProps?.ref as React.Ref<HTMLButtonElement> | undefined;
      return React.cloneElement(
        children as React.ReactElement<Record<string, unknown>>,
        {
          style: {
            touchAction: 'none',
            ...(childProps?.style as React.CSSProperties | undefined),
            ...style,
          },
          ref: (node: HTMLButtonElement | null) => {
            setRef(node);
            if (childRef) assignForwardedRef(childRef, node);
          },
          id: ctx.triggerId,
          'aria-haspopup': ctx.searchable ? 'listbox' : 'menu',
          'aria-expanded': ctx.open,
          'aria-controls': ctx.open ? ctx.menuId : undefined,
          'data-state': ctx.open ? 'open' : 'closed',
          'data-press-opens': '',
          onPointerDown: handlePointerDown,
          onClick: handleClick,
          onKeyDown: handleKeyDown,
        },
      );
    }

    return (
      <div className={styles.triggerWrap}>
        <GlassSurface
          shape="capsule"
          lens={false}
          material={material ?? ctx.materialControls.material ?? 'regular'}
          className={`${styles.triggerSurface} ${className}`.trim()}
        >
          <button
            ref={setRef}
            id={ctx.triggerId}
            type="button"
            aria-haspopup={ctx.searchable ? 'listbox' : 'menu'}
            aria-expanded={ctx.open}
            aria-controls={ctx.open ? ctx.menuId : undefined}
            data-state={ctx.open ? 'open' : 'closed'}
            data-press-opens=""
            onPointerDown={handlePointerDown}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            className={styles.trigger}
            style={style}
            {...otherProps}
          >
            {icon ? (
              <span aria-hidden="true" className={styles.triggerIcon}>
                {icon}
              </span>
            ) : null}
            <span className={styles.truncate}>{children}</span>
            {value !== undefined && value !== null ? (
              <span className={styles.triggerValue}>{value}</span>
            ) : null}
            {!hideChevron ? (
              <motion.span
                aria-hidden="true"
                className={styles.triggerChevron}
                initial={false}
                animate={{ rotate: ctx.open ? 180 : 0 }}
                transition={reduced ? TRANSITION.none : SNAP}
              >
                <ChevronDown size={16} />
              </motion.span>
            ) : null}
          </button>
        </GlassSurface>
      </div>
    );
  },
);

export { Trigger };
