import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import { useGlassDropdownContext, type SubLevelInfo } from './context';
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
        <div style={{ marginBottom: 4 }}>
          <motion.button
            layoutId={`${ctx.menuId}-sub-header-${activeMorphLevel.id}`}
            type="button"
            role="menuitem"
            data-dropdown-item-id={`${ctx.menuId}-back`}
            aria-expanded="true"
            onClick={(e) => {
              e.stopPropagation();
              ctx.popSub();
            }}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderRadius: '14px',
              border: 'none',
              background: 'rgba(21,20,15,0.05)',
              color: 'var(--paper-ink)',
              fontFamily: 'var(--font-sans)',
              fontSize: '13.5px',
              fontWeight: 600,
              lineHeight: '18px',
              cursor: 'pointer',
              textAlign: 'start',
            }}
          >
            {activeMorphLevel.icon ? (
              <span
                aria-hidden="true"
                style={{ display: 'inline-flex', color: 'var(--paper-ink)' }}
              >
                {activeMorphLevel.icon}
              </span>
            ) : (
              <ChevronLeft
                size={15}
                style={{ color: 'var(--paper-secondary-ink)' }}
              />
            )}
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeMorphLevel.label}
            </span>
            <SubmenuChevron id={activeMorphLevel.id} expanded />
          </motion.button>
          <Separator variant="hairline" />
        </div>
      ) : null}
    </>
  );
}
