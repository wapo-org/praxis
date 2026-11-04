import React from 'react';
import styles from './dropdown.module.css';
export interface HeaderProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'title'
> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}

const Header = React.forwardRef<HTMLDivElement, HeaderProps>(function Header(
  { title, subtitle, icon, badge, className = '', ...rest },
  ref,
) {
  return (
    <div ref={ref} className={`${styles.header} ${className}`.trim()} {...rest}>
      {icon ? (
        <span aria-hidden="true" className={styles.headerIcon}>
          {icon}
        </span>
      ) : null}
      <div className={styles.copy}>
        <span className={`${styles.headerTitle} ${styles.truncate}`}>{title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </div>
      {badge ? <span>{badge}</span> : null}
    </div>
  );
});

export interface LabelProps extends React.HTMLAttributes<HTMLDivElement> {
  inset?: boolean;
}

const Label = React.forwardRef<HTMLDivElement, LabelProps>(function Label(
  { inset = false, children, className = '', ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={`${styles.label} ${inset ? styles.labelInset : ''} ${className}`.trim()}
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
  { label, children, className = '', ...rest },
  ref,
) {
  return (
    <div ref={ref} role="group" className={`${styles.group} ${className}`.trim()} {...rest}>
      {label ? <Label>{label}</Label> : null}
      {children}
    </div>
  );
});

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'hairline' | 'section';
}

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  function Separator({ variant = 'hairline', className = '', ...rest }, ref) {
    return (
      <div
        ref={ref}
        role="separator"
        className={`${variant === 'section' ? styles.separatorSection : styles.separator} ${className}`.trim()}
        {...rest}
      />
    );
  },
);

export { Group, Header, Label, Separator };
