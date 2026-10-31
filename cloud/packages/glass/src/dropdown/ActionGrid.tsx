import React from 'react';
import {
  ACTION_GRID_MARKER,
  PanelHighlightContext,
  useGlassDropdownContext,
} from './context';
export interface ActionGridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: number;
  children: React.ReactNode;
}

function ActionGrid({
  columns = 3,
  children,
  className = '',
  style,
  ...rest
}: ActionGridProps) {
  return (
    <div
      role="group"
      data-slot="dropdown-action-grid"
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 0,
        background: 'transparent',
        borderBottom: 'none',
        margin: '-6px -6px 4px -6px',
        borderTopLeftRadius: '24px',
        borderTopRightRadius: '24px',
        overflow: 'hidden',
        position: 'relative',
        paddingBottom: 8,
        ...style,
      }}
      {...rest}
    >
      {children}
      <span aria-hidden style={{ position: 'absolute', bottom: 0, left: 16, right: 16, height: 1, background: 'var(--paper-hairline)' }} />
    </div>
  );
}
(ActionGrid as unknown as { [ACTION_GRID_MARKER]: boolean })[
  ACTION_GRID_MARKER
] = true;

export interface TileItemProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onSelect'
> {
  icon: React.ReactNode;
  active?: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}

const TileItem = React.forwardRef<HTMLButtonElement, TileItemProps>(
  function TileItem(
    {
      icon,
      active = false,
      keepOpen = false,
      disabled = false,
      onSelect,
      onClick,
      children,
      style,
      ...rest
    },
    ref,
  ) {
    const ctx = useGlassDropdownContext('TileItem');
    const panelHighlight = React.useContext(PanelHighlightContext);
    const itemId = React.useId();
    const isHighlighted = panelHighlight?.highlightedId === itemId;

    const activate = () => {
      if (disabled) return;
      onSelect?.();
      if (ctx.closeOnSelect && !keepOpen) {
        ctx.setOpen(false);
      }
    };

    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        data-dropdown-item-id={itemId}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        data-highlighted={isHighlighted || undefined}
        onPointerEnter={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onFocus={() => {
          if (!disabled) panelHighlight?.setHighlightedId(itemId);
        }}
        onClick={(e) => {
          onClick?.(e);
          if (!e.defaultPrevented) activate();
        }}
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '5px',
          minHeight: '58px',
          padding: '10px 6px',
          border: 'none',
          background: active
            ? 'rgba(21,20,15,0.09)'
            : isHighlighted
              ? 'rgba(21,20,15,0.06)'
              : 'transparent',
          color: 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '12px',
          fontWeight: 500,
          lineHeight: '15px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          userSelect: 'none',
          outline: 'none',
          ...style,
        }}
        {...rest}
      >
        <span
          aria-hidden="true"
          style={{ display: 'inline-flex', color: 'var(--paper-ink)' }}
        >
          {icon}
        </span>
        <span
          style={{
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {children}
        </span>
      </button>
    );
  },
);

export { ActionGrid, TileItem };
