import { GlassDropdown } from '@praxis/glass';
import React from 'react';
import { ChevronDown } from '../../lib/icons';
import styles from './fields.module.css';

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

export const fieldClass = { input: styles.input!, textarea: styles.textarea!, mono: styles.mono! };

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...props }, ref) {
    return <input ref={ref} className={cx(styles.input, mono && styles.mono, className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  function Textarea({ className, mono, ...props }, ref) {
    return <textarea ref={ref} className={cx(styles.textarea, mono && styles.mono, className)} {...props} />;
  },
);

interface ParsedOption {
  kind: 'option';
  value: string;
  label: string;
  disabled?: boolean;
}

interface ParsedGroup {
  kind: 'group';
  label: string;
  options: ParsedOption[];
}

type ParsedEntry = ParsedOption | ParsedGroup;

function nodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function parseSelectChildren(children: React.ReactNode): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<{ label?: string; value?: string | number; disabled?: boolean; children?: React.ReactNode }>(child)) return;
    if (child.type === React.Fragment) {
      entries.push(...parseSelectChildren(child.props.children));
      return;
    }
    if (child.type === 'option') {
      const label = nodeText(child.props.children);
      const rawValue = child.props.value !== undefined ? String(child.props.value) : label;
      entries.push({ kind: 'option', value: rawValue, label, disabled: child.props.disabled });
      return;
    }
    if (child.type === 'optgroup') {
      const groupOptions = parseSelectChildren(child.props.children).filter(
        (entry): entry is ParsedOption => entry.kind === 'option',
      );
      entries.push({ kind: 'group', label: child.props.label ?? '', options: groupOptions });
    }
  });
  return entries;
}

/** Shared select field powered by GlassDropdown, matching the pill field styling and select form semantics. */
export function Select({
  children,
  className,
  value,
  defaultValue,
  onChange,
  onBlur,
  onFocus,
  disabled,
  name,
  id,
  required,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const entries = React.useMemo(() => parseSelectChildren(children), [children]);
  const flatOptions = React.useMemo(
    () => entries.flatMap((entry) => (entry.kind === 'option' ? [entry] : entry.options)),
    [entries],
  );
  const firstFallback = flatOptions.find((opt) => !opt.disabled)?.value ?? flatOptions[0]?.value ?? '';
  const isControlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState<string>(
    defaultValue !== undefined ? String(defaultValue) : firstFallback,
  );
  const currentValue = isControlled ? String(value) : uncontrolled;
  const selectedOption = flatOptions.find((opt) => opt.value === currentValue) ?? flatOptions[0];

  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const handleSelect = React.useCallback(
    (nextValue: string) => {
      if (!isControlled) setUncontrolled(nextValue);
      if (onChange) {
        const target = Object.assign(
          triggerRef.current ?? { value: nextValue, name: name ?? '' },
          { value: nextValue, name: name ?? '' },
        );
        const syntheticEvent = {
          target,
          currentTarget: target,
        } as unknown as React.ChangeEvent<HTMLSelectElement>;
        onChange(syntheticEvent);
      }
      requestAnimationFrame(() => {
        triggerRef.current?.focus({ preventScroll: true });
      });
    },
    [isControlled, name, onChange],
  );

  const triggerWidth = open ? Math.max(220, Math.round(triggerRef.current?.getBoundingClientRect().width ?? 220)) : 220;
  return (
    <span className={cx(styles.select, className)}>
      {required ? (
        <input
          type="text"
          className={styles.validationProxy}
          name={name}
          value={currentValue}
          required
          disabled={disabled}
          tabIndex={-1}
          aria-hidden="true"
          onChange={() => {}}
        />
      ) : name ? (
        <input type="hidden" name={name} value={currentValue} disabled={disabled} />
      ) : null}
      <GlassDropdown
        open={open}
        onOpenChange={setOpen}
        align="start"
        side="auto"
        portal
        style={{ display: 'flex', width: '100%' }}
      >
        <GlassDropdown.Trigger asChild disabled={disabled}>
          <button
            ref={triggerRef}
            type="button"
            id={id}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-labelledby={!ariaLabel ? ariaLabelledBy : undefined}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            aria-required={required || undefined}
            data-value={currentValue}
            className={styles.selectTrigger}
            onFocus={onFocus as unknown as React.FocusEventHandler<HTMLButtonElement>}
            onBlur={onBlur as unknown as React.FocusEventHandler<HTMLButtonElement>}
          >
            <span className={styles.selectValue}>{selectedOption?.label ?? ''}</span>
            <ChevronDown size={16} aria-hidden="true" className={styles.selectChevron} />
          </button>
        </GlassDropdown.Trigger>
        <GlassDropdown.Content
          minWidth={triggerWidth}
          maxHeight={260}
          // A select's menu is as wide as its field, like the platform's, so options never truncate beside it.
          style={{ '--menu-max-width': `${triggerWidth}px` } as React.CSSProperties}
        >
          <GlassDropdown.RadioGroup value={currentValue} onValueChange={handleSelect}>
            {entries.map((entry, idx) =>
              entry.kind === 'option' ? (
                <GlassDropdown.RadioItem
                  key={`${entry.value}-${idx}`}
                  value={entry.value}
                  disabled={entry.disabled}
                >
                  {entry.label}
                </GlassDropdown.RadioItem>
              ) : (
                <React.Fragment key={`group-${entry.label}-${idx}`}>
                  {entry.label ? <GlassDropdown.Label>{entry.label}</GlassDropdown.Label> : null}
                  {entry.options.map((opt, optIdx) => (
                    <GlassDropdown.RadioItem
                      key={`${opt.value}-${optIdx}`}
                      value={opt.value}
                      disabled={opt.disabled}
                    >
                      {opt.label}
                    </GlassDropdown.RadioItem>
                  ))}
                </React.Fragment>
              ),
            )}
          </GlassDropdown.RadioGroup>
        </GlassDropdown.Content>
      </GlassDropdown>
    </span>
  );
}
