import { motion } from 'framer-motion';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMenuReducedMotion } from './motion';
export function SubmenuChevron({
  id,
  expanded,
}: {
  id: string;
  expanded: boolean;
}) {
  const reduced = useMenuReducedMotion();
  return reduced ? (
    expanded ? (
      <ChevronDown aria-hidden size={15} />
    ) : (
      <ChevronRight aria-hidden size={15} />
    )
  ) : (
    <motion.span
      aria-hidden
      data-submenu-id={id}
      data-submenu-chevron={expanded ? 'expanded' : 'collapsed'}
      initial={{ rotate: 0 }}
      animate={{ rotate: expanded ? 90 : 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        color: 'var(--paper-secondary-ink)',
      }}
    >
      <ChevronRight size={15} />
    </motion.span>
  );
}
