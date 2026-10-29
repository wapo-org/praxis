import React from 'react';
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search as SearchIcon, X } from 'lucide-react';
import { GlassSurface } from '../GlassSurface';
import { ScrollBlur } from '../ProgressiveBlurScrim';
import type { GlassMaterialControls } from '../glass-store';

export type GlassDropdownAlign = 'start' | 'center' | 'end';
export type GlassDropdownSide = 'top' | 'bottom' | 'auto';
export type GlassDropdownSubmenuMode = 'morph' | 'cascade';

interface SubLevelInfo {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}

interface GlassDropdownContextValue {
  open: boolean;
  setOpen: (next: boolean) => void;
  submenuMode: GlassDropdownSubmenuMode;
  align: GlassDropdownAlign;
  side: GlassDropdownSide;
  sideOffset: number;
  closeOnSelect: boolean;
  materialControls: GlassMaterialControls;
  registerTriggerEl: (el: HTMLElement | null) => void;
  getTriggerEl: () => HTMLElement | null;
  registerContentEl: (el: HTMLDivElement | null) => void;
  getContentEl: () => HTMLDivElement | null;
  focusTrigger: () => void;
  menuId: string;
  triggerId: string;
  activeSubPath: string[];
  morphDirection: 1 | -1;
  pushSub: (depth: number, subId: string) => void;
  popSub: (toDepth?: number) => void;
  startScrub: () => void;
  endScrub: () => void;
  isScrubbing: () => boolean;
  consumeScrubRelease: () => boolean;
}

const GlassDropdownContext = React.createContext<GlassDropdownContextValue | null>(null);

function useGlassDropdownContext(component: string): GlassDropdownContextValue {
  const ctx = React.useContext(GlassDropdownContext);
  if (!ctx) {
    throw new Error(`GlassDropdown.${component} must be used within <GlassDropdown>`);
  }
  return ctx;
}

interface PanelHighlightContextValue {
  highlightedId: string | null;
  setHighlightedId: (id: string | null) => void;
  layoutScopeId: string;
}

const PanelHighlightContext = React.createContext<PanelHighlightContextValue | null>(null);
const DepthContext = React.createContext<number>(0);

interface SubContextValue {
  subId: string;
  depth: number;
  isOpen: boolean;
  openSide: 'left' | 'right';
  setOpenSide: (side: 'left' | 'right') => void;
  registerSubTriggerEl: (el: HTMLButtonElement | null) => void;
  getSubTriggerEl: () => HTMLButtonElement | null;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
}

const SubContext = React.createContext<SubContextValue | null>(null);

const SUB_MARKER = Symbol.for('praxis.GlassDropdown.Sub');
const SUB_TRIGGER_MARKER = Symbol.for('praxis.GlassDropdown.SubTrigger');
const SUB_CONTENT_MARKER = Symbol.for('praxis.GlassDropdown.SubContent');
const ACTION_GRID_MARKER = Symbol.for('praxis.GlassDropdown.ActionGrid');
const SEARCH_MARKER = Symbol.for('praxis.GlassDropdown.Search');

function assignForwardedRef<T>(ref: React.ForwardedRef<T>, node: T | null): void {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

function getSubIdentifier(props: SubProps): string {
  if (props.id) return props.id;
  if (typeof props.label === 'string' && props.label) return props.label;
  let text = '';
  React.Children.forEach(props.children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as { [SUB_TRIGGER_MARKER]?: boolean };
    if (childType?.[SUB_TRIGGER_MARKER]) {
      const triggerProps = child.props as SubTriggerProps;
      if (typeof triggerProps.children === 'string') {
        text = triggerProps.children;
      }
    }
  });
  return text || 'submenu';
}

function extractSubMeta(subElement: React.ReactElement<SubProps>): {
  label: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  contentChildren: React.ReactNode;
} {
  let label: React.ReactNode = subElement.props.label;
  let icon: React.ReactNode = subElement.props.icon;
  let subtitle: React.ReactNode = subElement.props.subtitle;
  let contentChildren: React.ReactNode = null;

  React.Children.forEach(subElement.props.children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as {
      [SUB_TRIGGER_MARKER]?: boolean;
      [SUB_CONTENT_MARKER]?: boolean;
    };
    if (childType?.[SUB_TRIGGER_MARKER]) {
      const triggerProps = child.props as SubTriggerProps;
      if (label === undefined) label = triggerProps.children;
      if (icon === undefined) icon = triggerProps.icon;
      if (subtitle === undefined) subtitle = triggerProps.subtitle;
    } else if (childType?.[SUB_CONTENT_MARKER]) {
      const contentProps = child.props as SubContentProps;
      contentChildren = contentProps.children;
    }
  });

  return {
    label: label ?? subElement.props.id ?? 'Submenu',
    icon,
    subtitle,
    contentChildren,
  };
}

function findSubInChildren(
  nodes: React.ReactNode,
  targetId: string,
): React.ReactElement<SubProps> | null {
  let found: React.ReactElement<SubProps> | null = null;
  const walk = (children: React.ReactNode) => {
    React.Children.forEach(children, (child) => {
      if (found || !React.isValidElement(child)) return;
      const childType = child.type as { [SUB_MARKER]?: boolean };
      if (childType?.[SUB_MARKER]) {
        const subEl = child as React.ReactElement<SubProps>;
        if (getSubIdentifier(subEl.props) === targetId) {
          found = subEl;
          return;
        }
      }
      const childProps = child.props as { children?: React.ReactNode };
      if (childProps?.children && !childType?.[SUB_MARKER]) {
        walk(childProps.children);
      }
    });
  };
  walk(nodes);
  return found;
}

function resolveMorphTrail(
  rootChildren: React.ReactNode,
  activeSubPath: string[],
): {
  trail: SubLevelInfo[];
  activeChildren: React.ReactNode;
} {
  const trail: SubLevelInfo[] = [];
  let currentChildren: React.ReactNode = rootChildren;

  for (let depth = 0; depth < activeSubPath.length; depth++) {
    const targetId = activeSubPath[depth];
    if (!targetId) break;
    const subEl = findSubInChildren(currentChildren, targetId);
    if (!subEl) break;
    const meta = extractSubMeta(subEl);
    trail.push({
      id: targetId,
      label: meta.label,
      icon: meta.icon,
      subtitle: meta.subtitle,
      children: meta.contentChildren,
    });
    currentChildren = meta.contentChildren;
  }

  return { trail, activeChildren: currentChildren };
}

/* -------------------------------------------------------------------------- */
/* Trigger                                                                    */
/* -------------------------------------------------------------------------- */

export interface TriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'>,
    GlassMaterialControls {
  icon?: React.ReactNode;
  value?: React.ReactNode;
  hideChevron?: boolean;
  asChild?: boolean;
  children?: React.ReactNode;
}

const Trigger = React.forwardRef<HTMLButtonElement, TriggerProps>(function Trigger(
  {
    icon,
    value,
    hideChevron = false,
    asChild = false,
    children,
    className = '',
    material,
    intensity,
    refraction,
    frost,
    finish,
    backdrop,
    stretchable = false,
    bounce = true,
    spotlight = true,
    onClick,
    onPointerDown,
    onKeyDown,
    style,
    ...otherProps
  },
  forwardedRef,
) {
  const ctx = useGlassDropdownContext('Trigger');

  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      ctx.registerTriggerEl(node);
      assignForwardedRef(forwardedRef, node);
    },
    [ctx, forwardedRef],
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(e);
    if (e.defaultPrevented || e.button !== 0) return;
    ctx.startScrub();
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    ctx.endScrub();
    ctx.setOpen(!ctx.open);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.setOpen(true);
    } else if (e.key === 'Escape' && ctx.open) {
      e.preventDefault();
      ctx.setOpen(false);
    }
  };

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(
      children as React.ReactElement<Record<string, unknown>>,
      {
        ref: setRef,
        id: ctx.triggerId,
        'aria-haspopup': 'menu',
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
      animate={{ scale: ctx.open ? 0.965 : 1 }}
      transition={{ type: 'spring', stiffness: 520, damping: 32 }}
      style={{ display: 'inline-flex', maxWidth: '100%' }}
    >
      <GlassSurface
        shape="capsule"
        material={material ?? ctx.materialControls.material ?? 'regular'}
        intensity={intensity ?? ctx.materialControls.intensity}
        refraction={refraction ?? ctx.materialControls.refraction}
        frost={frost ?? ctx.materialControls.frost}
        finish={finish ?? ctx.materialControls.finish}
        backdrop={backdrop ?? ctx.materialControls.backdrop}
        stretchable={stretchable}
        bounce={bounce}
        spotlight={spotlight}
        className={className}
        style={{ display: 'inline-flex', maxWidth: '100%' }}
      >
        <button
          ref={setRef}
          id={ctx.triggerId}
          type="button"
          aria-haspopup="menu"
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
            outline: 'none',
            ...style,
          }}
          {...otherProps}
        >
          {icon ? (
            <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--paper-secondary-ink)' }}>
              {icon}
            </span>
          ) : null}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
              size={14}
              style={{
                color: 'var(--paper-muted-ink)',
                transform: ctx.open ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 180ms ease',
              }}
            />
          ) : null}
        </button>
      </GlassSurface>
    </motion.div>
  );
});

/* -------------------------------------------------------------------------- */
/* Top Quick-Action Tile Grid (IMG_7749: Scan | Pin Note | Lock)              */
/* -------------------------------------------------------------------------- */

export interface ActionGridProps extends React.HTMLAttributes<HTMLDivElement> {
  columns?: number;
  children: React.ReactNode;
}

function ActionGrid({ columns = 3, children, className = '', style, ...rest }: ActionGridProps) {
  return (
    <div
      role="group"
      data-slot="dropdown-action-grid"
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: '1px',
        background: 'var(--paper-hairline)',
        borderBottom: '1px solid var(--paper-hairline)',
        margin: '-6px -6px 4px -6px',
        borderTopLeftRadius: '22px',
        borderTopRightRadius: '22px',
        overflow: 'hidden',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
(ActionGrid as unknown as { [ACTION_GRID_MARKER]: boolean })[ACTION_GRID_MARKER] = true;

export interface TileItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  icon: React.ReactNode;
  active?: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}

const TileItem = React.forwardRef<HTMLButtonElement, TileItemProps>(function TileItem(
  { icon, active = false, keepOpen = false, disabled = false, onSelect, onClick, children, style, ...rest },
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
      onPointerUp={(e) => {
        if (!disabled && ctx.consumeScrubRelease()) {
          e.preventDefault();
          activate();
        }
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
            : 'var(--glass-tile-bg, rgba(251,251,249,0.45))',
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
      <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--paper-ink)' }}>
        {icon}
      </span>
      <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </button>
  );
});

/* -------------------------------------------------------------------------- */
/* Search Bar (Sticky combobox filter inside dropdown)                        */
/* -------------------------------------------------------------------------- */

export interface SearchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  value: string;
  onValueChange: (next: string) => void;
}

const Search = React.forwardRef<HTMLInputElement, SearchProps>(function Search(
  { value, onValueChange, placeholder = 'Filter…', style, ...rest },
  ref,
) {
  return (
    <div
      data-slot="dropdown-search"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        margin: '0 0 4px 0',
        borderRadius: '12px',
        background: 'var(--paper-fill-1)',
        border: '1px solid var(--paper-hairline)',
      }}
    >
      <SearchIcon size={14} style={{ color: 'var(--paper-muted-ink)', flexShrink: 0 }} />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onValueChange('');
          }
        }}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--paper-ink)',
          fontFamily: 'var(--font-sans)',
          fontSize: '13px',
          lineHeight: '18px',
          outline: 'none',
          ...style,
        }}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--paper-muted-ink)',
            padding: 2,
            display: 'inline-flex',
            cursor: 'pointer',
          }}
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
});
(Search as unknown as { [SEARCH_MARKER]: boolean })[SEARCH_MARKER] = true;

/* -------------------------------------------------------------------------- */
/* Header, Label, Group, Separator                                            */
/* -------------------------------------------------------------------------- */

export interface HeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

const Header = React.forwardRef<HTMLDivElement, HeaderProps>(function Header(
  { title, subtitle, icon, badge, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 12px',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {icon ? (
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            border: '1px solid var(--paper-hairline)',
            background: 'var(--paper-fill-1)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--paper-ink)',
          }}
        >
          {icon}
        </span>
      ) : null}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            fontWeight: 600,
            lineHeight: '17px',
            color: 'var(--paper-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        {subtitle ? (
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: '11px',
              lineHeight: '14px',
              color: 'var(--paper-secondary-ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
      {badge ? <span>{badge}</span> : null}
    </div>
  );
});

export interface LabelProps extends React.HTMLAttributes<HTMLDivElement> {
  inset?: boolean;
}

const Label = React.forwardRef<HTMLDivElement, LabelProps>(function Label(
  { inset = false, children, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      style={{
        padding: `6px 12px 4px ${inset ? '34px' : '12px'}`,
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--paper-muted-ink)',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface GroupProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
}

const Group = React.forwardRef<HTMLDivElement, GroupProps>(function Group(
  { label, children, style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="group"
      style={{ display: 'flex', flexDirection: 'column', width: '100%', ...style }}
      {...rest}
    >
      {label ? <Label>{label}</Label> : null}
      {children}
    </div>
  );
});

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'hairline' | 'section';
}

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(function Separator(
  { variant = 'hairline', style, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      role="separator"
      style={
        variant === 'section'
          ? {
              margin: '4px -6px',
              height: '7px',
              background: 'rgba(21,20,15,0.035)',
              borderTop: '1px solid var(--paper-hairline)',
              borderBottom: '1px solid var(--paper-hairline)',
              ...style,
            }
          : {
              margin: '3px -6px',
              height: '1px',
              background: 'var(--paper-hairline)',
              ...style,
            }
      }
      {...rest}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Menu Items (Item, CheckboxItem, RadioGroup, RadioItem)                     */
/* -------------------------------------------------------------------------- */

export interface ItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
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
    <button
      ref={ref}
      type="button"
      role="menuitem"
      data-dropdown-item-id={itemId}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      data-highlighted={isHighlighted || undefined}
      data-tone={tone}
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
      onPointerUp={(e) => {
        onPointerUp?.(e);
        if (!e.defaultPrevented && !disabled && ctx.consumeScrubRelease()) {
          e.preventDefault();
          activate();
        }
      }}
      style={{
        position: 'relative',
        display: 'flex',
        width: '100%',
        alignItems: lines > 1 ? 'flex-start' : 'center',
        gap: '10px',
        borderRadius: '14px',
        padding: lines > 1 ? '10px 12px' : '8.5px 12px',
        border: 'none',
        background: 'transparent',
        color: isDestructive ? 'var(--paper-destructive)' : 'var(--paper-ink)',
        fontFamily: 'var(--font-sans)',
        fontSize: '13.5px',
        fontWeight: 500,
        lineHeight: '18px',
        textAlign: 'start',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        userSelect: 'none',
        outline: 'none',
        ...style,
      }}
      {...otherProps}
    >
      {/* Fluid glass-native highlight pill */}
      {isHighlighted && !disabled ? (
        <motion.span
          layoutId={`${panelHighlight?.layoutScopeId ?? 'menu'}-highlight`}
          aria-hidden="true"
          transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }}
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
            color: isDestructive ? 'var(--paper-destructive)' : 'var(--paper-secondary-ink)',
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
              color: isDestructive ? 'var(--paper-destructive)' : 'var(--paper-secondary-ink)',
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
            color: isDestructive ? 'var(--paper-destructive)' : 'var(--paper-secondary-ink)',
          }}
        >
          {trailingIcon}
        </span>
      ) : null}

      {/* Trailing interactive action (e.g. pin star button) */}
      {trailingAction ? (
        <span
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          {trailingAction}
        </span>
      ) : null}
    </button>
  );
});

export interface CheckboxItemProps extends Omit<ItemProps, 'selected' | 'onSelect'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const CheckboxItem = React.forwardRef<HTMLButtonElement, CheckboxItemProps>(function CheckboxItem(
  { checked, onCheckedChange, keepOpen = true, ...rest },
  ref,
) {
  return (
    <Item
      ref={ref}
      role="menuitemcheckbox"
      aria-checked={checked}
      selected={checked}
      keepOpen={keepOpen}
      onSelect={() => onCheckedChange(!checked)}
      {...rest}
    />
  );
});

interface RadioGroupContextValue {
  value: string;
  onValueChange: (val: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (val: string) => void;
}

function RadioGroup({ value, onValueChange, children, ...rest }: RadioGroupProps) {
  const ctx = React.useMemo(() => ({ value, onValueChange }), [value, onValueChange]);
  return (
    <RadioGroupContext.Provider value={ctx}>
      <div role="group" {...rest}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioItemProps extends Omit<ItemProps, 'selected' | 'onSelect' | 'value'> {
  value: string;
}

const RadioItem = React.forwardRef<HTMLButtonElement, RadioItemProps>(function RadioItem(
  { value, ...rest },
  ref,
) {
  const group = React.useContext(RadioGroupContext);
  const selected = group?.value === value;
  return (
    <Item
      ref={ref}
      role="menuitemradio"
      aria-checked={selected}
      selected={selected}
      onSelect={() => group?.onValueChange(value)}
      {...rest}
    />
  );
});

/* -------------------------------------------------------------------------- */
/* Submenu (Sub, SubTrigger, SubContent)                                      */
/* -------------------------------------------------------------------------- */

export interface SubProps {
  id?: string;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
}

function Sub(props: SubProps) {
  const { label, icon, subtitle, children } = props;
  const ctx = useGlassDropdownContext('Sub');
  const depth = React.useContext(DepthContext);
  const subId = getSubIdentifier(props);
  const isOpen = ctx.activeSubPath[depth] === subId;
  const [openSide, setOpenSide] = React.useState<'left' | 'right'>('right');
  const triggerElRef = React.useRef<HTMLButtonElement | null>(null);

  const registerSubTriggerEl = React.useCallback((el: HTMLButtonElement | null) => {
    triggerElRef.current = el;
  }, []);
  const getSubTriggerEl = React.useCallback(() => triggerElRef.current, []);

  const subCtx = React.useMemo<SubContextValue>(
    () => ({
      subId,
      depth,
      isOpen,
      openSide,
      setOpenSide,
      registerSubTriggerEl,
      getSubTriggerEl,
      label,
      icon,
      subtitle,
    }),
    [subId, depth, isOpen, openSide, registerSubTriggerEl, getSubTriggerEl, label, icon, subtitle],
  );

  const triggerNodes: React.ReactNode[] = [];
  const contentNodes: React.ReactNode[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const childType = child.type as { [SUB_CONTENT_MARKER]?: boolean };
    if (childType?.[SUB_CONTENT_MARKER]) {
      contentNodes.push(child);
    } else {
      triggerNodes.push(child);
    }
  });

  return (
    <SubContext.Provider value={subCtx}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%' }}>
        {triggerNodes}
        {ctx.submenuMode === 'cascade' ? contentNodes : null}
      </div>
    </SubContext.Provider>
  );
}
(Sub as unknown as { [SUB_MARKER]: boolean })[SUB_MARKER] = true;

export interface SubTriggerProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'> {
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: React.ReactNode;
  inset?: boolean;
  disabled?: boolean;
  children?: React.ReactNode;
}

const SubTrigger = React.forwardRef<HTMLButtonElement, SubTriggerProps>(function SubTrigger(
  { icon, subtitle, value, inset = false, disabled = false, children, onClick, onPointerEnter, onKeyDown, style, ...rest },
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
    panelHighlight?.highlightedId === itemId || (ctx.submenuMode === 'cascade' && sub.isOpen);

  const openSubmenu = () => {
    if (disabled) return;
    ctx.pushSub(sub.depth, sub.subId);
  };

  return (
    <motion.button
      ref={setRef}
      layoutId={`sub-header-${sub.subId}`}
      type="button"
      role="menuitem"
      data-dropdown-item-id={itemId}
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
        padding: '8.5px 12px',
        border: 'none',
        background: 'transparent',
        color: 'var(--paper-ink)',
        fontFamily: 'var(--font-sans)',
        fontSize: '13.5px',
        fontWeight: 500,
        lineHeight: '18px',
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
          transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '14px',
            backgroundColor: 'var(--dropdown-highlight, rgba(21, 20, 15, 0.075))',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      ) : null}

      {inset ? <span style={{ width: 16, height: 16, flexShrink: 0 }} /> : null}
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
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {children}
        </span>
        {subtitle ? (
          <span
            style={{
              fontSize: '11.5px',
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

      <ChevronRight
        aria-hidden="true"
        size={14}
        style={{
          position: 'relative',
          zIndex: 1,
          color: 'var(--paper-muted-ink)',
          marginInlineStart: value === undefined ? 'auto' : '4px',
        }}
      />
    </motion.button>
  );
});
(SubTrigger as unknown as { [SUB_TRIGGER_MARKER]: boolean })[SUB_TRIGGER_MARKER] = true;

export interface SubContentProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'>,
    GlassMaterialControls {
  children?: React.ReactNode;
}

const SubContent = React.forwardRef<HTMLDivElement, SubContentProps>(function SubContent(
  { children, style, ...rest },
  forwardedRef,
) {
  const ctx = useGlassDropdownContext('SubContent');
  const sub = React.useContext(SubContext);
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);
  const scopeId = React.useId();

  const highlightCtx = React.useMemo<PanelHighlightContextValue>(
    () => ({
      highlightedId,
      setHighlightedId,
      layoutScopeId: `sub-${scopeId}`,
    }),
    [highlightedId, scopeId],
  );

  if (!sub || ctx.submenuMode !== 'cascade') return null;

  return (
    <AnimatePresence>
      {sub.isOpen ? (
        <DepthContext.Provider value={sub.depth + 1}>
          <PanelHighlightContext.Provider value={highlightCtx}>
            <motion.div
              ref={forwardedRef}
              role="menu"
              aria-label={typeof sub.label === 'string' ? sub.label : 'Submenu'}
              initial={{ opacity: 0, scale: 0.62, x: sub.openSide === 'right' ? -10 : 10 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.78, transition: { duration: 0.12 } }}
              transition={{ type: 'spring', stiffness: 460, damping: 28, mass: 0.8 }}
              style={{
                position: 'absolute',
                zIndex: 60,
                minWidth: 224,
                top: -6,
                ...(sub.openSide === 'right'
                  ? { left: 'calc(100% + 8px)' }
                  : { right: 'calc(100% + 8px)' }),
                ...style,
              }}
              onPointerLeave={() => setHighlightedId(null)}
              {...rest}
            >
              <GlassSurface shape="free" radius={22} {...ctx.materialControls} style={{ padding: 6 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
              </GlassSurface>
            </motion.div>
          </PanelHighlightContext.Provider>
        </DepthContext.Provider>
      ) : null}
    </AnimatePresence>
  );
});
(SubContent as unknown as { [SUB_CONTENT_MARKER]: boolean })[SUB_CONTENT_MARKER] = true;

/* -------------------------------------------------------------------------- */
/* VirtualList (60fps windowing for 500+ models inside GlassDropdown)         */
/* -------------------------------------------------------------------------- */

export interface VirtualListProps<T> {
  items: readonly T[];
  itemHeight?: number;
  height?: number;
  overscan?: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  emptyState?: React.ReactNode;
}

function VirtualList<T>({
  items,
  itemHeight = 48,
  height = 300,
  overscan = 6,
  renderItem,
  emptyState,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = React.useState(0);

  if (items.length === 0) {
    return (
      <div
        style={{
          padding: '24px 12px',
          textAlign: 'center',
          fontSize: '13px',
          color: 'var(--paper-muted-ink)',
        }}
      >
        {emptyState ?? 'No matching items'}
      </div>
    );
  }

  const totalHeight = items.length * itemHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(height / itemHeight) + overscan * 2;
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const offsetY = startIndex * itemHeight;

  return (
    <ScrollBlur
      maxHeight={ Math.min(height, totalHeight + 12)}
      scrimHeight={22}
      onViewportScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ position: 'relative', height: totalHeight, width: '100%' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${offsetY}px)`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {items.slice(startIndex, endIndex).map((item, i) => (
            <div key={startIndex + i} style={{ minHeight: itemHeight }}>
              {renderItem(item, startIndex + i)}
            </div>
          ))}
        </div>
      </div>
    </ScrollBlur>
  );
}

/* -------------------------------------------------------------------------- */
/* Content (Root Menu Sheet — IMG_7745..7778 Physics & Morph)                 */
/* -------------------------------------------------------------------------- */

export interface ContentProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'>,
    GlassMaterialControls {
  maxHeight?: number;
  minWidth?: number;
  children?: React.ReactNode;
}

const Content = React.forwardRef<HTMLDivElement, ContentProps>(function Content(
  {
    maxHeight = 380,
    minWidth = 252,
    children,
    className = '',
    material,
    intensity,
    refraction,
    frost,
    finish,
    backdrop,
    stretchable = true,
    bounce,
    spotlight = true,
    onKeyDown,
    style,
    ...otherProps
  },
  forwardedRef,
) {
  const ctx = useGlassDropdownContext('Content');
  const pathKey = ctx.activeSubPath.join('/');
  const [highlightState, setHighlightState] = React.useState<{ key: string; id: string | null }>({
    key: pathKey,
    id: null,
  });
  const scopeId = React.useId();

  const highlightedId = highlightState.key === pathKey ? highlightState.id : null;
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

  // Viewport collision resolution (auto-flip top/bottom and horizontal shift)
  const [resolvedSide, setResolvedSide] = React.useState<'top' | 'bottom'>(
    ctx.side === 'top' ? 'top' : 'bottom',
  );
  const [shiftX, setShiftX] = React.useState(0);

  React.useLayoutEffect(() => {
    if (!ctx.open) return;
    const triggerEl = ctx.getTriggerEl();
    if (!triggerEl || typeof window === 'undefined') return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (ctx.side === 'auto') {
      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      setResolvedSide(spaceBelow < 320 && spaceAbove > spaceBelow ? 'top' : 'bottom');
    } else {
      setResolvedSide(ctx.side);
    }

    const contentEl = ctx.getContentEl();
    const menuW = contentEl?.offsetWidth || minWidth;
    let nextShift = 0;
    if (ctx.align === 'start' && rect.left + menuW > vw - 12) {
      nextShift = Math.min(0, vw - 12 - (rect.left + menuW));
    } else if (ctx.align === 'end' && rect.right - menuW < 12) {
      nextShift = Math.max(0, 12 - (rect.right - menuW));
    }
    setShiftX(nextShift);
  }, [ctx, minWidth]);

  // Continuous cross-row touch & pointer scrubbing + 2D elastic pull (IMG_7754–IMG_7767)
  const pullX = useMotionValue(0);
  const pullY = useMotionValue(0);
  const springPullX = useSpring(pullX, { stiffness: 420, damping: 26 });
  const springPullY = useSpring(pullY, { stiffness: 420, damping: 26 });
  const stretchScaleY = useTransform(springPullY, (y) => 1 + Math.min(0.055, Math.abs(y) / 920));
  const pointerDownOriginRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    if (!ctx.open) return;
    const handleWindowPointerMove = (e: PointerEvent) => {
      const contentEl = ctx.getContentEl();
      if (!contentEl) return;

      if (ctx.isScrubbing() || pointerDownOriginRef.current) {
        if (typeof document.elementFromPoint === 'function') {
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const itemEl = hit?.closest<HTMLElement>('[data-dropdown-item-id]');
          if (itemEl && contentEl.contains(itemEl) && !itemEl.hasAttribute('disabled')) {
            const id = itemEl.getAttribute('data-dropdown-item-id');
            if (id) setHighlightedId(id);
          }
        }
      }

      if (stretchable && pointerDownOriginRef.current) {
        const dx = e.clientX - pointerDownOriginRef.current.x;
        const dy = e.clientY - pointerDownOriginRef.current.y;
        pullX.set(18 * Math.tanh(dx / (18 * 2.2)));
        pullY.set(48 * Math.tanh(dy / (48 * 2.2)));
      }
    };

    const handleWindowPointerUp = () => {
      pointerDownOriginRef.current = null;
      pullX.set(0);
      pullY.set(0);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
    };
  }, [ctx, stretchable, pullX, pullY, setHighlightedId]);

  const highlightCtx = React.useMemo<PanelHighlightContextValue>(
    () => ({
      highlightedId,
      setHighlightedId,
      layoutScopeId: `root-${scopeId}-${pathKey}`,
    }),
    [highlightedId, setHighlightedId, scopeId, pathKey],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const container = ctx.getContentEl();
    if (!container) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      if (ctx.activeSubPath.length > 0) {
        ctx.popSub();
      } else {
        ctx.setOpen(false);
        ctx.focusTrigger();
      }
      return;
    }

    if (
      (e.key === 'ArrowLeft' || e.key === 'Backspace') &&
      ctx.activeSubPath.length > 0 &&
      (document.activeElement as HTMLElement)?.tagName !== 'INPUT'
    ) {
      e.preventDefault();
      ctx.popSub();
      return;
    }

    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
      ),
    );
    if (items.length === 0) return;

    const currentIndex = items.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[(currentIndex + 1) % items.length];
      next?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[(currentIndex - 1 + items.length) % items.length];
      prev?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const mergedControls: GlassMaterialControls = {
    material: material ?? ctx.materialControls.material ?? 'regular',
    intensity: intensity ?? ctx.materialControls.intensity,
    refraction: refraction ?? ctx.materialControls.refraction,
    frost: frost ?? ctx.materialControls.frost,
    finish: finish ?? ctx.materialControls.finish,
    backdrop: backdrop ?? ctx.materialControls.backdrop,
    stretchable: false,
    bounce,
    spotlight: spotlight ?? ctx.materialControls.spotlight ?? true,
  };

  const morphState = React.useMemo(() => {
    if (ctx.submenuMode !== 'morph' || ctx.activeSubPath.length === 0) {
      return { trail: [] as SubLevelInfo[], activeChildren: children };
    }
    return resolveMorphTrail(children, ctx.activeSubPath);
  }, [ctx.submenuMode, ctx.activeSubPath, children]);

  const activeMorphLevel =
    morphState.trail.length > 0 ? morphState.trail[morphState.trail.length - 1] : null;

  // Separate top sticky ActionGrid / Search from scrollable list when at root level
  const topPinnedNodes: React.ReactNode[] = [];
  const scrollableNodes: React.ReactNode[] = [];

  React.Children.forEach(morphState.activeChildren, (child) => {
    if (
      !activeMorphLevel &&
      React.isValidElement(child) &&
      ((child.type as { [ACTION_GRID_MARKER]?: boolean })?.[ACTION_GRID_MARKER] ||
        (child.type as { [SEARCH_MARKER]?: boolean })?.[SEARCH_MARKER])
    ) {
      topPinnedNodes.push(child);
    } else {
      scrollableNodes.push(child);
    }
  });

  const transformOrigin = `${resolvedSide === 'top' ? 'bottom' : 'top'} ${
    ctx.align === 'end' ? 'right' : ctx.align === 'center' ? 'center' : 'left'
  }`;

  const sidePosStyle: React.CSSProperties =
    resolvedSide === 'top'
      ? { bottom: `calc(100% + ${ctx.sideOffset}px)` }
      : { top: `calc(100% + ${ctx.sideOffset}px)` };

  const alignPosStyle: React.CSSProperties =
    ctx.align === 'end'
      ? { insetInlineEnd: 0 }
      : ctx.align === 'center'
        ? { left: '50%', transform: 'translateX(-50%)' }
        : { insetInlineStart: 0 };

  return (
    <AnimatePresence>
      {ctx.open ? (
        <DepthContext.Provider value={0}>
          <PanelHighlightContext.Provider value={highlightCtx}>
            <motion.div
              ref={setRef}
              id={ctx.menuId}
              role="menu"
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
              /* IMG_7745–IMG_7752 Unfurl Pop Motion */
              initial={{
                opacity: 0,
                scaleX: 0.38,
                scaleY: 0.28,
                y: resolvedSide === 'top' ? 10 : -10,
                filter: 'blur(6px)',
              }}
              animate={{
                opacity: 1,
                scaleX: 1,
                scaleY: 1,
                y: 0,
                filter: 'blur(0px)',
              }}
              exit={{
                opacity: 0,
                scaleX: 0.74,
                scaleY: 0.74,
                y: resolvedSide === 'top' ? 6 : -6,
                filter: 'blur(4px)',
                transition: { duration: 0.12, ease: 'easeIn' },
              }}
              transition={{
                type: 'spring',
                stiffness: 380,
                damping: 24,
                mass: 0.82,
              }}
              className={`praxis-glass-dropdown-content ${className}`.trim()}
              style={{
                position: 'absolute',
                zIndex: 80,
                minWidth,
                transformOrigin,
                x: springPullX,
                y: springPullY,
                scaleY: stretchScaleY,
                marginLeft: shiftX ? `${shiftX}px` : undefined,
                ...sidePosStyle,
                ...alignPosStyle,
                ...style,
              }}
              {...otherProps}
            >
              <GlassSurface
                shape="free"
                radius={24}
                {...mergedControls}
                style={{
                  width: '100%',
                  overflow: ctx.submenuMode === 'cascade' ? 'visible' : 'hidden',
                  padding: '6px',
                }}
              >
                {/* Layout-spring height container (IMG_7769–IMG_7774 submenu morph) */}
                <motion.div
                  layout="size"
                  transition={{ type: 'spring', stiffness: 360, damping: 26, mass: 0.85 }}
                  style={{ width: '100%' }}
                >
                  <AnimatePresence mode="popLayout" initial={false} custom={ctx.morphDirection}>
                    <motion.div
                      key={pathKey || '__root__'}
                      custom={ctx.morphDirection}
                      initial={{
                        opacity: 0,
                        y: ctx.morphDirection > 0 ? 12 : -12,
                        scale: 0.97,
                      }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        scale: 1,
                      }}
                      exit={{
                        opacity: 0,
                        y: ctx.morphDirection > 0 ? -12 : 12,
                        scale: 0.97,
                        transition: { duration: 0.12 },
                      }}
                      transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.8 }}
                      style={{ display: 'flex', flexDirection: 'column', width: '100%' }}
                    >
                      {/* Elevated Submenu Sticky Header (IMG_7773–IMG_7774: "Recent Notes ⌄") */}
                      {activeMorphLevel ? (
                        <div style={{ marginBottom: 4 }}>
                          <motion.button
                            layoutId={`sub-header-${activeMorphLevel.id}`}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              ctx.popSub();
                            }}
                            style={{
                              display: 'flex',
                              width: '100%',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '9px 12px',
                              borderRadius: '14px',
                              border: 'none',
                              background: 'rgba(21,20,15,0.05)',
                              color: 'var(--paper-ink)',
                              fontFamily: 'var(--font-sans)',
                              fontSize: '13.5px',
                              fontWeight: 600,
                              lineHeight: '18px',
                              cursor: 'pointer',
                              textAlign: 'start',
                            }}
                          >
                            {activeMorphLevel.icon ? (
                              <span
                                aria-hidden="true"
                                style={{ display: 'inline-flex', color: 'var(--paper-ink)' }}
                              >
                                {activeMorphLevel.icon}
                              </span>
                            ) : (
                              <ChevronLeft size={15} style={{ color: 'var(--paper-secondary-ink)' }} />
                            )}
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {activeMorphLevel.label}
                            </span>
                            <ChevronDown
                              aria-hidden="true"
                              size={15}
                              style={{ color: 'var(--paper-secondary-ink)', flexShrink: 0 }}
                            />
                          </motion.button>
                          <Separator variant="hairline" />
                        </div>
                      ) : null}

                      {/* Top pinned ActionGrid & Search */}
                      {topPinnedNodes}

                      {/* Scrollable items with progressive blur edge scrims */}
                      <ScrollBlur maxHeight={maxHeight} scrimHeight={20}>
                        <DepthContext.Provider value={morphState.trail.length}>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '2px',
                              width: '100%',
                            }}
                          >
                            {scrollableNodes}
                          </div>
                        </DepthContext.Provider>
                      </ScrollBlur>
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </GlassSurface>
            </motion.div>
          </PanelHighlightContext.Provider>
        </DepthContext.Provider>
      ) : null}
    </AnimatePresence>
  );
});

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */

export interface GlassDropdownRootProps
  extends React.HTMLAttributes<HTMLDivElement>,
    GlassMaterialControls {
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

const GlassDropdownRoot = React.forwardRef<HTMLDivElement, GlassDropdownRootProps>(
  function GlassDropdownRoot(
    {
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
    const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;

    const [subPathState, setSubPathState] = React.useState<string[]>(defaultSubPath);
    const activeSubPath = controlledSubPath !== undefined ? controlledSubPath : subPathState;
    const [morphDirection, setMorphDirection] = React.useState<1 | -1>(1);

    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const triggerElRef = React.useRef<HTMLElement | null>(null);
    const contentElRef = React.useRef<HTMLDivElement | null>(null);
    const scrubbingRef = React.useRef(false);
    const pressTimestampRef = React.useRef(0);

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
      pressTimestampRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
      scrubbingRef.current = true;
    }, []);
    const endScrub = React.useCallback(() => {
      scrubbingRef.current = false;
    }, []);
    const isScrubbing = React.useCallback(() => scrubbingRef.current, []);
    const consumeScrubRelease = React.useCallback(() => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (scrubbingRef.current && now - pressTimestampRef.current > 150) {
        scrubbingRef.current = false;
        return true;
      }
      return false;
    }, []);

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
        if (rootRef.current?.contains(target)) return;
        setOpen(false);
      };
      const handlePointerUp = () => {
        scrubbingRef.current = false;
      };
      document.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('pointerup', handlePointerUp);
      return () => {
        document.removeEventListener('pointerdown', handlePointerDown);
        window.removeEventListener('pointerup', handlePointerUp);
      };
    }, [open, dismissOnOutsideClick, setOpen]);

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
      [material, intensity, refraction, frost, finish, backdrop, stretchable, bounce, spotlight],
    );

    const ctxValue = React.useMemo<GlassDropdownContextValue>(
      () => ({
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
        consumeScrubRelease,
      }),
      [
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
        consumeScrubRelease,
      ],
    );

    return (
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
    );
  },
);

export const GlassDropdown = Object.assign(GlassDropdownRoot, {
  Trigger,
  Content,
  ActionGrid,
  TileItem,
  Search,
  Header,
  Label,
  Group,
  Item,
  CheckboxItem,
  RadioGroup,
  RadioItem,
  Sub,
  SubTrigger,
  SubContent,
  Separator,
  VirtualList,
});
