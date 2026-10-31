import React from 'react';
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
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
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
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        ...style,
      }}
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

const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  function Separator({ variant = 'hairline', style, ...rest }, ref) {
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
  },
);

export { Group, Header, Label, Separator };
