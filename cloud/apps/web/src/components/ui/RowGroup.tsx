import React from 'react';
import styles from './RowGroup.module.css';

/**
 * Rows that sit next to each other become one group (DESIGN.md "Lists"). Put adjacent rows in one RowGroup;
 * a group of one row is a lone squircle.
 */
export const RowGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function RowGroup(
  { className = '', ...props },
  ref,
) {
  return <div ref={ref} data-row-group="" className={`${styles.group} ${className}`.trim()} {...props} />;
});

/** The row class for any element inside a RowGroup; `interactive` adds hover, press and focus. */
export const rowClass = (interactive = false) => (interactive ? `${styles.row} ${styles.interactive}` : styles.row!);
