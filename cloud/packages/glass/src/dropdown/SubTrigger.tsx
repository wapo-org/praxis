import styles from './dropdown.module.css';
import { SubmenuChevron } from './SubmenuChevron';
import { SPRING } from '../motion';
export interface SubTriggerProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'value' | 'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
> {
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  inset?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}

import { m as motion } from 'framer-motion';
import React from 'react';
import {
  assignForwardedRef,
  PanelHighlightContext,
  SUB_TRIGGER_MARKER,
  SubContext,
  useGlassDropdownContext,
} from './context';
const SubTrigger = React.forwardRef<HTMLButtonElement, SubTriggerProps>(
  function SubTrigger(
    {
      icon,
      subtitle,
      value,
      inset = false,
      disabled = false,
      children,
      onClick,
      onPointerEnter,
      onKeyDown,
      style,
      ...rest
    },
    forwardedRef,
  ) {
    const ctx = useGlassDropdownContext('SubTrigger');
    const sub = React.useContext(SubContext);
    const panelHighlight = React.useContext(PanelHighlightContext);
    const itemId = React.useId();

    const setRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        sub?.registerSubTriggerEl(node);
        assignForwardedRef(forwardedRef, node);
      },
      [sub, forwardedRef],
    );

    if (!sub) return null;

    const isHighlighted =
      panelHighlight?.highlightedId === itemId ||
      (ctx.submenuMode === 'cascade' && sub.isOpen);

    const openSubmenu = () => {
      if (disabled) return;
      ctx.pushSub(sub.depth, sub.subId);
    };

    return (
      <motion.button
        ref={setRef}
        layoutId={`${ctx.menuId}-sub-header-${sub.subId}`}
        type="button"
        role="menuitem"
        data-dropdown-item-id={itemId}
        data-dropdown-sub-id={sub.subId}
        aria-haspopup="menu"
        aria-expanded={sub.isOpen}
        disabled={disabled}
        onPointerEnter={(e) => {
          onPointerEnter?.(e);
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onFocus={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onClick={(e) => {
          onClick?.(e);
          if (e.defaultPrevented || disabled) return;
          e.stopPropagation();
          if (ctx.submenuMode === 'cascade' && sub.isOpen) {
            ctx.popSub(sub.depth);
          } else {
            openSubmenu();
          }
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || disabled) return;
          ctx.pointerOpening.current = false;
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            openSubmenu();
          }
        }}
        className={styles.item}
        style={style}
        {...rest}
      >
        {isHighlighted && !disabled ? (
          <motion.span
            layoutId={`${panelHighlight?.layoutScopeId ?? 'menu'}-highlight`}
            aria-hidden="true"
            transition={SPRING}
            className={styles.highlight}
          />
        ) : null}

        {inset ? <span aria-hidden="true" className={styles.slot} /> : null}
        {icon ? (
          <span aria-hidden="true" className={styles.slot}>
            {icon}
          </span>
        ) : null}

        <span className={styles.copy}>
          <span className={styles.truncate}>{children}</span>
          {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
        </span>

        {value !== undefined && value !== null ? <span className={styles.meta}>{value}</span> : null}

        <SubmenuChevron id={sub.subId} expanded={false} />
      </motion.button>
    );
  },
);
(SubTrigger as unknown as { [SUB_TRIGGER_MARKER]: boolean })[
  SUB_TRIGGER_MARKER
] = true;

export { SubTrigger };
