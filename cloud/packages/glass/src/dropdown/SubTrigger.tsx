import { SubmenuChevron } from './SubmenuChevron';
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

import { motion } from 'framer-motion';
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
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          gap: '10px',
          borderRadius: '14px',
          minHeight: 40,
          padding: '9px 12px',
          border: 'none',
          background: 'transparent',
          color: 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '17px',
          fontWeight: 500,
          lineHeight: '22px',
          textAlign: 'start',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          userSelect: 'none',
          outline: 'none',
          ...style,
        }}
        {...rest}
      >
        {isHighlighted && !disabled ? (
          <motion.span
            layoutId={`${panelHighlight?.layoutScopeId ?? 'menu'}-highlight`}
            aria-hidden="true"
            transition={{
              type: 'spring',
              stiffness: 520,
              damping: 36,
              mass: 0.7,
            }}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '14px',
              backgroundColor:
                'var(--dropdown-highlight, rgba(21, 20, 15, 0.075))',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        ) : null}

        {inset ? (
          <span style={{ width: 16, height: 16, flexShrink: 0 }} />
        ) : null}
        {icon ? (
          <span
            aria-hidden="true"
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'inline-flex',
              width: 16,
              height: 16,
              flexShrink: 0,
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--paper-secondary-ink)',
            }}
          >
            {icon}
          </span>
        ) : null}

        <span
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {children}
          </span>
          {subtitle ? (
            <span
              style={{
                fontSize: '13px',
                color: 'var(--paper-secondary-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {subtitle}
            </span>
          ) : null}
        </span>

        {value !== undefined && value !== null ? (
          <span
            style={{
              position: 'relative',
              zIndex: 1,
              fontSize: '12px',
              color: 'var(--paper-secondary-ink)',
              marginInlineStart: 'auto',
            }}
          >
            {value}
          </span>
        ) : null}

        <SubmenuChevron id={sub.subId} expanded={false} />
      </motion.button>
    );
  },
);
(SubTrigger as unknown as { [SUB_TRIGGER_MARKER]: boolean })[
  SUB_TRIGGER_MARKER
] = true;

export { SubTrigger };
