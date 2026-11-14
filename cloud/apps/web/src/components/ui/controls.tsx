import { SNAP, useReducedMotion } from '@praxis/glass';
import { motion } from 'framer-motion';
import React from 'react';
import styles from './controls.module.css';

/** Equal-width segmented control. The thumb springs between segments and reverses from wherever it is. */
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
  const reduced = useReducedMotion();
  return (
    <div
      className={styles.segmented}
      role="group"
      aria-label={label}
      style={
        { '--segment-count': options.length } as React.CSSProperties
      }
    >
      {index >= 0 ? (
        <motion.span
          className={styles.thumb}
          aria-hidden="true"
          initial={false}
          animate={{ x: `${index * 100}%` }}
          transition={reduced ? { duration: 0 } : SNAP}
        />
      ) : null}
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
  const reduced = useReducedMotion();
  return (
    <motion.span
      className={styles.switch}
      data-checked={checked}
      data-disabled={disabled || undefined}
      whileTap={disabled || reduced ? undefined : 'pressed'}
    >
      <input
        className={styles.switchInput}
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <motion.span
        className={styles.knob}
        aria-hidden="true"
        initial={false}
        animate={{ x: checked ? 16 : 0 }}
        variants={{ pressed: { scaleX: 1.14 } }}
        transition={reduced ? { duration: 0 } : SNAP}
      />
    </motion.span>
  );
}
