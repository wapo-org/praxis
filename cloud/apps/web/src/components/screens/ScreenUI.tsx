import React from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  GlassCard,
  GlassDropdown,
  GlassIconButton,
  GlassSurface,
  MOTION,
  ProgressiveBlurScrim,
} from '@praxis/glass';
import './screens.css';

export function useScreenTask() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const running = React.useRef(false);
  const run = async (task: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Something went wrong. Please try again.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function TaskError({ error }: { error: string | null }) {
  return error ? (
    <p className="screen-error" role="alert">
      {error}
    </p>
  ) : null;
}

export function ScreenButton({
  children,
  tone = 'secondary',
  className = '',
  ...props
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'onAnimationStart' | 'onDrag' | 'onDragEnd' | 'onDragStart'
> & {
  tone?: 'primary' | 'secondary' | 'destructive';
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97, opacity: 0.84 }}
      transition={MOTION.press}
      className={`screen-button screen-button--${tone} ${className}`}
      {...props}
    >
      {children}
    </motion.button>
  );
}

export function Section({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = React.useId();
  return (
    <section className="screen-section" aria-labelledby={id}>
      <h2 id={id} className="screen-section-title">
        {title}
      </h2>
      {children}
      {hint ? <p className="screen-footnote">{hint}</p> : null}
    </section>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return (
    <GlassCard
      className="screen-card"
      style={{
        background: 'var(--paper-card)',
        border: '1px solid var(--paper-hairline)',
      }}
    >
      {children}
    </GlassCard>
  );
}

export function NavRow({
  icon,
  title,
  detail,
  value,
  onClick,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  value?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="screen-row screen-nav-row"
      onClick={onClick}
    >
      {icon ? <span className="screen-row-icon">{icon}</span> : null}
      <span className="screen-row-copy">
        <span>{title}</span>
        {detail ? <span className="screen-detail">{detail}</span> : null}
      </span>
      {value !== undefined ? (
        <span className="screen-row-value">{value}</span>
      ) : null}
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  detail,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  detail?: string;
}) {
  return (
    <label className="screen-row screen-toggle-row">
      <span className="screen-row-copy">
        <span>{label}</span>
        {detail ? <span className="screen-detail">{detail}</span> : null}
      </span>
      <input
        className="screen-toggle"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="screen-field">
      <span>{label}</span>
      {children}
      {hint ? <span className="screen-footnote">{hint}</span> : null}
    </label>
  );
}

export function ScreenHeader({
  title,
  onBack,
  onClose,
  trailing,
}: {
  title: string;
  onBack?: () => void;
  onClose?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <header className="screen-header">
      <div className="screen-header-side">
        {onBack ? (
          <GlassIconButton label="Back" onClick={onBack}>
            <ChevronLeft size={20} />
          </GlassIconButton>
        ) : null}
      </div>
      <h1 className="screen-title">{title}</h1>
      <div className="screen-header-side screen-header-side--end">
        {trailing ??
          (onClose ? (
            <GlassIconButton
              label={`Close ${title.toLowerCase()}`}
              onClick={onClose}
            >
              <X size={18} />
            </GlassIconButton>
          ) : null)}
      </div>
    </header>
  );
}

export function ScreenBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="screen-scroll-frame">
      <div className="screen-body">{children}</div>
      <ProgressiveBlurScrim edge="top" height={12} />
      <ProgressiveBlurScrim edge="bottom" height={24} />
    </div>
  );
}

/** Keep the current non-portaling dropdown API above the sheet's scroll viewport. */
export function ScreenMenu({
  label,
  children,
  icon,
}: {
  label: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const trigger = React.useRef<HTMLButtonElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const target = trigger.current?.closest<HTMLElement>('.screen-shell');
  React.useLayoutEffect(() => {
    if (!open || !target || !trigger.current) return;
    const measure = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const shell = target.getBoundingClientRect();
      const height = content.current?.offsetHeight || 160;
      const width = content.current?.offsetWidth || 200;
      const below = anchor.bottom - shell.top + 8;
      setPosition({
        left: Math.max(
          8,
          Math.min(anchor.right - shell.left - width, shell.width - width - 8),
        ),
        top: Math.max(
          8,
          Math.min(
            below + height <= shell.height - 8
              ? below
              : anchor.top - shell.top - height - 8,
            shell.height - height - 8,
          ),
        ),
      });
    };
    measure();
    const onOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger.current?.contains(event.target) &&
        !content.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    target.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      target.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, target]);
  return (
    <GlassDropdown
      open={open}
      onOpenChange={setOpen}
      dismissOnOutsideClick={false}
      align="end"
    >
      <GlassDropdown.Trigger ref={trigger} aria-label={label} hideChevron>
        {icon}
      </GlassDropdown.Trigger>
      {open && target
        ? createPortal(
            <GlassDropdown.Content
              ref={content}
              minWidth={200}
              maxHeight={240}
              style={{
                position: 'absolute',
                insetInlineStart: 'auto',
                insetInlineEnd: 'auto',
                bottom: 'auto',
                left: position.left,
                top: position.top,
                marginLeft: 0,
                zIndex: 60,
              }}
            >
              {children}
            </GlassDropdown.Content>,
            target,
          )
        : null}
    </GlassDropdown>
  );
}

/** Each portal isolates the background, traps focus, and restores it on dismissal. */
export function SheetDialog({
  label,
  onDismiss,
  children,
  consent = false,
}: {
  label: string;
  onDismiss: () => void;
  children: React.ReactNode;
  consent?: boolean;
}) {
  const reduced = useReducedMotion();
  const [portal] = React.useState(() => document.createElement('div'));
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  React.useLayoutEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    portal.className = 'praxis-sheets-portal';
    const siblings = Array.from(document.body.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    const states = siblings.map((node) => ({ node, inert: node.inert }));
    states.forEach(({ node }) => {
      node.inert = true;
    });
    document.body.append(portal);
    dialogRef.current?.focus();
    return () => {
      portal.remove();
      states.forEach(({ node, inert }) => {
        node.inert = inert;
      });
      if (previous?.isConnected && !previous.closest('[inert]'))
        previous.focus();
    };
  }, [portal]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (dialogRef.current?.querySelector('[role="menu"]')) return;
      event.stopPropagation();
      dismissRef.current();
    }
    if (event.key !== 'Tab') return;
    const elements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
      ) ?? [],
    ).filter(
      (node) => node.getClientRects().length > 0 && !node.closest('[inert]'),
    );
    const first = elements[0];
    const last = elements.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      className={`screen-overlay${consent ? ' screen-overlay--consent' : ''}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismissRef.current();
      }}
    >
      <motion.div
        className="screen-dialog-position"
        initial={{ opacity: 0, y: reduced ? 0 : 36, scale: reduced ? 1 : 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0.15 } : MOTION.morph}
      >
        <GlassSurface
          className="screen-dialog"
          radius={24}
          shape="free"
          material="regular"
        >
          <div
            className="screen-shell"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
          >
            {children}
          </div>
        </GlassSurface>
      </motion.div>
    </div>,
    portal,
  );
}

export function requireHttpUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('Enter an HTTP or HTTPS server URL.');
  if (url.username || url.password)
    throw new Error('Use the API key or token field for credentials.');
  return url.toString();
}

export function hostLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
