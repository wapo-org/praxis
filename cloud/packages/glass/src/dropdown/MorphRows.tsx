import { motion } from 'framer-motion';
import React from 'react';
/** Children follow the shared header as it rises, rather than appearing as a single opaque block. */
export function MorphRows({ children, stagger, reduced }: { children: React.ReactNode; stagger: boolean; reduced: boolean }) {
  return <>{React.Children.toArray(children).map((child, index) => <motion.div key={React.isValidElement(child) ? child.key ?? index : index}
    data-dropdown-child={index}
    initial={stagger && !reduced ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }}
    transition={reduced ? { duration: 0 } : { duration: .14, delay: stagger ? .06 + index * .03 : 0 }}>
    {child}
  </motion.div>)}</>;
}
