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

/** Native select (the OS picker is the right control) dressed as the pill field. */
export function Select({ children, className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx(styles.select, className)}>
      <select {...props}>{children}</select>
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}
