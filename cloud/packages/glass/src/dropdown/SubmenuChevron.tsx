import { m as motion } from 'framer-motion';
import { SPRING } from '../motion';
import { ChevronDown, ChevronRight } from '../icons';
import styles from './dropdown.module.css';
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
      <ChevronDown aria-hidden size={16} />
    ) : (
      <ChevronRight aria-hidden size={16} />
    )
  ) : (
    <motion.span
      aria-hidden
      data-submenu-id={id}
      data-submenu-chevron={expanded ? 'expanded' : 'collapsed'}
      initial={{ rotate: 0 }}
      animate={{ rotate: expanded ? 90 : 0 }}
      transition={SPRING}
      className={styles.chevron}
    >
      <ChevronRight size={16} />
    </motion.span>
  );
}
