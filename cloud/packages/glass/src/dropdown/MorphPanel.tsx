import { motion, useIsPresent, type HTMLMotionProps } from 'framer-motion';
import React from 'react';
/** Exiting layers stay visible for the crossfade, but leave the accessibility/focus tree. */
export const MorphPanel = React.forwardRef<
  HTMLDivElement,
  HTMLMotionProps<'div'>
>(function MorphPanel(props, ref) {
  const present = useIsPresent();
  return (
    <motion.div
      {...props}
      ref={ref}
      inert={!present}
      aria-hidden={!present || undefined}
    />
  );
});
