import { usePress } from '@praxis/glass';
import { motion } from 'framer-motion';
import { ChevronLeft } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { SETTINGS_NAV, settingsPage, type SettingsSheet } from '../screens/settingsNav';
import styles from './Sidebar.module.css';
import { SidebarHeader } from './SidebarHeader';

/** The same floating panel, taken over by Settings: sections and a way back to chats. */
export function SidebarSettings({
  sheet,
  onClose,
  onNavigate,
  devTools,
}: {
  sheet: SettingsSheet;
  onClose?: () => void;
  onNavigate?: () => void;
  devTools: boolean;
}) {
  const store = usePraxisStore();
  const pressProps = usePress();
  const current = settingsPage(sheet).section;
  const items = SETTINGS_NAV.filter((item) => !item.devOnly || devTools);
  return (
    <>
      <SidebarHeader
        label="Back"
        Icon={ChevronLeft}
        testId="settings-back"
        actionLabel="Close settings"
        onAction={() => store.setActiveSheet(null)}
        onClose={() => {
          store.setDesktopSidebarOpen(false);
          onClose?.();
        }}
      />
      <nav className={styles.list} aria-label="Settings sections">
        {items.map(({ sheet: target, title, Icon }) => (
          <motion.button
            key={target}
            type="button"
            className={styles.navRow}
            data-testid={`settings-nav-${target}`}
            aria-current={current === target ? 'page' : undefined}
            onClick={() => {
              store.setActiveSheet(target);
              onNavigate?.();
            }}
            {...pressProps}
          >
            <Icon size={16} />
            <span className={styles.rowTitle}>{title}</span>
          </motion.button>
        ))}
      </nav>
    </>
  );
}
