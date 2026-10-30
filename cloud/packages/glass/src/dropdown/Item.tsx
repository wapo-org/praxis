import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import React from 'react';
import { PanelHighlightContext, useGlassDropdownContext } from './context';
export interface ItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect'
> {
  icon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  trailingAction?: React.ReactNode;
  subtitle?: React.ReactNode;
  shortcut?: string;
  badge?: React.ReactNode;
  tone?: 'default' | 'destructive';
  selected?: boolean;
  inset?: boolean;
  keepOpen?: boolean;
  /** Number of lines to allow for label/preview (1 = truncate, 2 or 3 = multi-line clamp as in IMG_7773). */
  lines?: 1 | 2 | 3;
  onSelect?: () => void;
}

const Item = React.forwardRef<HTMLButtonElement, ItemProps>(function Item(
  {
    icon,
    trailingIcon,
    trailingAction,
    subtitle,
    shortcut,
    badge,
    tone = 'default',
    selected,
    inset = false,
    keepOpen = false,
    lines = 1,
    disabled = false,
    onSelect,
    children,
    onClick,
    onPointerEnter,
    onPointerUp,
    style,
    ...otherProps
  },
  ref,
) {
  const ctx = useGlassDropdownContext('Item');
  const panelHighlight = React.useContext(PanelHighlightContext);
  const itemId = React.useId();
  const isHighlighted = panelHighlight?.highlightedId === itemId;
  const isDestructive = tone === 'destructive';

  const activate = () => {
    if (disabled) return;
    onSelect?.();
    if (ctx.closeOnSelect && !keepOpen) {
      ctx.setOpen(false);
    }
  };

  const textClampStyle: React.CSSProperties =
    lines === 1
      ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      : {
          display: '-webkit-box',
          WebkitLineClamp: lines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          whiteSpace: 'normal',
        };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={ref}
        type="button"
        role={ctx.searchable ? 'option' : 'menuitem'}
        aria-selected={ctx.searchable ? !!selected : undefined}
        data-dropdown-item-id={itemId}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        data-highlighted={isHighlighted || undefined}
        data-tone={tone}
        onPointerUp={onPointerUp}
        onPointerEnter={(e) => {
          onPointerEnter?.(e);
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onFocus={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented && !disabled) activate();
        }}
        style={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          alignItems: lines > 1 ? 'flex-start' : 'center',
          minHeight: lines > 1 ? lines * 18 + 20 : undefined,
          gap: '10px',
          borderRadius: '14px',
          padding: lines > 1 ? '10px 12px' : '8.5px 12px',
          border: 'none',
          background: 'transparent',
          color: isDestructive
            ? 'var(--paper-destructive)'
            : 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13.5px',
          fontWeight: 500,
          lineHeight: '18px',
          textAlign: 'start',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          userSelect: 'none',
          outline: 'none',
          ...(trailingAction ? { paddingInlineEnd: 44 } : {}),
          ...style,
        }}
        {...otherProps}
      >
        {/* Fluid glass-native highlight pill */}
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
              backgroundColor: isDestructive
                ? 'rgba(179, 56, 46, 0.12)'
                : 'var(--dropdown-highlight, rgba(21, 20, 15, 0.075))',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        ) : null}

        {/* Leading icon or checkmark slot */}
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
              marginTop: lines > 1 ? 2 : 0,
              color: isDestructive
                ? 'var(--paper-destructive)'
                : 'var(--paper-secondary-ink)',
            }}
          >
            {icon}
          </span>
        ) : selected !== undefined || inset ? (
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
            }}
          >
            {selected ? <Check size={14} strokeWidth={2.25} /> : null}
          </span>
        ) : null}

        {/* Label & subtitle */}
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
          <span style={textClampStyle}>{children}</span>
          {subtitle ? (
            <span
              style={{
                fontSize: '11.5px',
                fontWeight: 400,
                lineHeight: '15px',
                color: isDestructive
                  ? 'var(--paper-destructive)'
                  : 'var(--paper-secondary-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {subtitle}
            </span>
          ) : null}
        </span>

        {/* Trailing checkmark when leading slot has an icon */}
        {icon && selected ? (
          <span
            aria-hidden="true"
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'inline-flex',
              marginInlineStart: 'auto',
              color: 'var(--paper-ink)',
            }}
          >
            <Check size={14} strokeWidth={2.25} />
          </span>
        ) : null}

        {/* Badge / DotMeter */}
        {badge !== undefined && badge !== null ? (
          <span
            style={{
              position: 'relative',
              zIndex: 1,
              flexShrink: 0,
              marginInlineStart: icon && selected ? '6px' : 'auto',
            }}
          >
            {badge}
          </span>
        ) : null}

        {/* Shortcut */}
        {shortcut ? (
          <span
            style={{
              position: 'relative',
              zIndex: 1,
              flexShrink: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--paper-muted-ink)',
              marginInlineStart: badge !== undefined ? '6px' : 'auto',
            }}
          >
            {shortcut}
          </span>
        ) : null}

        {/* Trailing icon */}
        {trailingIcon ? (
          <span
            aria-hidden="true"
            style={{
              position: 'relative',
              zIndex: 1,
              display: 'inline-flex',
              color: isDestructive
                ? 'var(--paper-destructive)'
                : 'var(--paper-secondary-ink)',
            }}
          >
            {trailingIcon}
          </span>
        ) : null}
      </button>
      {/* Trailing interactive action (e.g. pin star button) */}
      {trailingAction ? (
        <span
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          {trailingAction}
        </span>
      ) : null}
    </div>
  );
});

export { Item };
