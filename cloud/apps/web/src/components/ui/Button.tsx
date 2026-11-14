import { usePress } from '@praxis/glass';
import { motion, type HTMLMotionProps } from 'framer-motion';
import React from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full width of its container. */
  block?: boolean;
}

/** The app's one button: a pill in four variants and three sizes, with the shared press. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block = false, className = '', type = 'button', ...props },
  ref,
) {
  const press = usePress();
  const classes = [styles.button, styles[variant], size === 'md' ? '' : styles[size], block ? styles.block : '', className]
    .filter(Boolean)
    .join(' ');
  return <motion.button ref={ref} type={type} {...press} data-variant={variant} className={classes} {...props} />;
});
