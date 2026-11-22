import { usePress, type BoundIcon } from '@praxis/glass';
import { motion } from 'framer-motion';
import { PanelLeft } from '../../lib/icons';
import styles from './Sidebar.module.css';
export function SidebarHeader({
  label,
  Icon,
  onAction,
  onClose,
  testId,
  actionLabel,
}: {
  label: string;
  Icon: BoundIcon;
  onAction: () => void;
  onClose: () => void;
  testId: string;
  actionLabel?: string;
}) {
  const press = usePress();
  return (
    <div className={styles.header}>
      <motion.button
        type="button"
        className={styles.primaryPill}
        data-testid={testId}
        aria-label={actionLabel}
        title={actionLabel ?? label}
        onClick={onAction}
        {...press}
      >
        <Icon size={16} />
        <span className={styles.rowTitle}>{label}</span>
      </motion.button>
      <motion.button
        type="button"
        className={styles.iconButton}
        aria-label="Close sidebar"
        title="Close sidebar"
        data-testid="sidebar-toggle"
        onClick={onClose}
        {...press}
      >
        <PanelLeft size={16} />
      </motion.button>
    </div>
  );
}
