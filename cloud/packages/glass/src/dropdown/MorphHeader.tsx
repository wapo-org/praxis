import { m as motion } from 'framer-motion';
import { ChevronLeft } from '../icons';
import { useGlassDropdownContext, type SubLevelInfo } from './context';
import styles from './dropdown.module.css';
import { Separator } from './parts';
import { SubmenuChevron } from './SubmenuChevron';
export function MorphHeader({
  level: activeMorphLevel,
}: {
  level: SubLevelInfo | null;
}) {
  const ctx = useGlassDropdownContext('MorphHeader');
  return (
    <>
      {activeMorphLevel ? (
        <div className={styles.morphHeaderWrap}>
          <motion.button
            layoutId={`${ctx.menuId}-sub-header-${activeMorphLevel.id}`}
            data-dropdown-morph-header
            type="button"
            role="menuitem"
            data-dropdown-item-id={`${ctx.menuId}-back`}
            aria-expanded="true"
            onClick={(e) => {
              e.stopPropagation();
              ctx.popSub();
            }}
            className={styles.morphHeader}
          >
            {activeMorphLevel.icon ? (
              <span aria-hidden="true" className={styles.morphIcon}>
                {activeMorphLevel.icon}
              </span>
            ) : (
              <ChevronLeft size={16} className={styles.morphBack} />
            )}
            <span className={styles.morphTitle}>
              {activeMorphLevel.label}
            </span>
            <SubmenuChevron id={activeMorphLevel.id} expanded />
          </motion.button>
          <Separator variant="hairline" className={styles.morphSeparator} />
        </div>
      ) : null}
    </>
  );
}
