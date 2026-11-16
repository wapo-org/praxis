import React from 'react';
import styles from './controls.module.css';

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  optionLabel,
  testIdPrefix,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
  optionLabel?: (option: T) => string;
  testIdPrefix?: string;
}) {
  const index = options.indexOf(value);
  return (
    <div
      className={styles.segmented}
      role="group"
      aria-label={label}
      style={
        { '--segment-count': options.length, '--segment-index': Math.max(index, 0) } as React.CSSProperties
      }
    >
      {index >= 0 ? <span className={styles.thumb} aria-hidden="true" /> : null}
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={styles.segment}
          aria-pressed={option === value}
          data-testid={testIdPrefix ? `${testIdPrefix}-${option}` : undefined}
          onClick={() => onChange(option)}
        >
          {optionLabel ? optionLabel(option) : option}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      className={styles.switch}
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
