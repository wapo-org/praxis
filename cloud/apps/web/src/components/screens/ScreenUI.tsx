import { GlassDropdown, ScrollBlur, usePress } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown } from '../../lib/icons';
import { Switch } from '../ui/controls';
import styles from './Screen.module.css';

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
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function TaskError({ error }: { error: string | null }) {
  return error ? (
    <p className={styles.error} role="alert">
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
  const pressProps = usePress();
  return (
    <motion.button
      type="button"
      {...pressProps}
      data-tone={tone}
      className={`${styles.button} ${className}`.trim()}
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
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {children}
      {hint ? <p className={styles.footnote}>{hint}</p> : null}
    </section>
  );
}

/** Grouped rows: an opaque card on the sheet. Content is never glass. */
export function Card({ children }: { children: React.ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}

export function NavRow({
  icon,
  title,
  detail,
  value,
  onClick,
  testId,
}: {
  icon?: React.ReactNode;
  title: string;
  detail?: string;
  value?: React.ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.row} ${styles.navRow}`}
      data-testid={testId}
      onClick={onClick}
    >
      {icon ? <span className={styles.rowIcon}>{icon}</span> : null}
      <span className={styles.rowCopy}>
        <span>{title}</span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
      {value !== undefined ? <span className={styles.rowValue}>{value}</span> : null}
      <span className={styles.chevron}>
        <ChevronRight size={16} aria-hidden="true" />
      </span>
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
    <label className={styles.row}>
      <span className={styles.rowCopy}>
        <span>{label}</span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
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
    <label className={styles.field}>
      <span>{label}</span>
      {children}
      {hint ? <span className={styles.footnote}>{hint}</span> : null}
    </label>
  );
}

/** Native select (the OS picker is the right control) dressed to match the other fields. */
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={styles.select}>
      <select {...props}>{children}</select>
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

/** One-of-many choice when the options can overflow a segmented control. */
export function ChoiceChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.chip} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
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
    <header className={styles.header}>
      <div className={styles.headerSide}>
        {onBack ? <BackButton onClick={onBack} /> : null}
      </div>
      <h1 className={styles.title}>{title}</h1>
      <div className={`${styles.headerSide} ${styles.headerEnd}`}>
        {trailing ??
          (onClose ? (
            <button
              type="button"
              aria-label={`Close ${title.toLowerCase()}`}
              onClick={onClose}
              className={styles.textButton}
            >
              Done
            </button>
          ) : null)}
      </div>
    </header>
  );
}

export function BackButton({
  onClick,
  className = '',
  ...rest
}: { onClick: () => void; className?: string } & React.HTMLAttributes<HTMLButtonElement> & {
    'data-section-root'?: string;
  }) {
  return (
    <button
      type="button"
      className={`${styles.iconButton} ${className}`.trim()}
      aria-label="Back"
      title="Back"
      onClick={onClick}
      {...rest}
    >
      <ChevronLeft size={20} />
    </button>
  );
}

export function ScreenBody({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      <ScrollBlur height="100%">
        <div className={styles.body}>{children}</div>
      </ScrollBlur>
    </div>
  );
}

/** Menu opened from a settings row: the content portals to the document root
 * (GlassDropdown `portal`), so it is never clipped by a scroll container,
 * an ancestor's overflow, or another glass surface's backdrop root. */
export function ScreenMenu({
  label,
  children,
  icon,
  plain = false,
}: {
  /** Render the trigger as an inline value + chevron (form rows), not a glass capsule. */
  plain?: boolean;
  label: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      // A press inside the menu is the menu's: it must stay open until the row has its click.
      if (!(event.target instanceof Element) || trigger.current?.contains(event.target) || event.target.closest('.praxis-glass-dropdown-content')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [open]);
  return (
    <GlassDropdown open={open} onOpenChange={setOpen} dismissOnOutsideClick={false} align="end" portal>
      <GlassDropdown.Trigger
        asChild={plain}
        ref={trigger}
        aria-label={label}
        hideChevron
      >
        {plain ? (
          <button type="button" className={styles.menuValue} aria-label={label}>
            {icon}
            <ChevronsUpDown size={16} aria-hidden="true" />
          </button>
        ) : (
          icon
        )}
      </GlassDropdown.Trigger>
      <GlassDropdown.Content minWidth={200} maxHeight={240}>
        {children}
      </GlassDropdown.Content>
    </GlassDropdown>
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
