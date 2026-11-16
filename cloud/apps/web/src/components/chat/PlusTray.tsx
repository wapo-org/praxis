import { effortsFor, modelDetail } from '../../lib/models';
import { GlassSurface, popIn, slideIn, slideUnder, usePreset } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { Camera, ChevronRight, Copy, Folder, Globe, Link, Photo, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { SegmentedControl, Switch } from '../ui/controls';
import { ModelList } from './ModelList';
import styles from './PlusTray.module.css';

export { getUnpinnedModels } from './ModelList';
export interface PlusTrayProps {
  onPickFiles: (accept?: string, capture?: boolean) => void;
}

const MODES = ['auto', 'ask', 'plan', 'build'] as const;
const TILES = [
  { name: 'Photos', Icon: Photo, accept: 'image/*' },
  { name: 'Camera', Icon: Camera, accept: 'image/*', capture: true },
  { name: 'Files', Icon: Folder, accept: '*/*' },
  { name: 'Screenshot', Icon: Copy, accept: 'image/*' },
];
const EFFORT_DETAIL: Record<string, string> = {
  low: 'Quick answers, minimal tool use',
  medium: 'Balanced: a few tools, checked once',
  high: 'Thorough: plans first, verifies after',
  max: 'Exhaustive: plans, verifies, retries',
};

export function PlusTray({ onPickFiles }: PlusTrayProps) {
  const open = usePraxisStore().plusTrayOpen;
  return <AnimatePresence>{open ? <TrayPopover key="tray" onPickFiles={onPickFiles} /> : null}</AnimatePresence>;
}

function TrayPopover({ onPickFiles }: PlusTrayProps) {
  const store = usePraxisStore();
  const pop = usePreset(popIn);
  const push = usePreset(slideIn);
  const under = usePreset(slideUnder);
  const [view, setView] = React.useState<'main' | 'models'>('main');
  const surface = React.useRef<HTMLDivElement>(null);
  const modelRow = React.useRef<HTMLButtonElement>(null);
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const close = React.useRef(store.setPlusTrayOpen);
  close.current = store.setPlusTrayOpen;

  const plusButton = () =>
    surface.current?.closest('[data-testid="composer-dock"]')?.querySelector<HTMLElement>('[data-testid="composer-plus-button"]');

  React.useEffect(() => {
    surface.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (viewRef.current === 'models') {
        setView('main');
        modelRow.current?.focus({ preventScroll: true });
      } else {
        plusButton()?.focus({ preventScroll: true });
        close.current(false);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (surface.current?.contains(target) || plusButton()?.contains(target)) return;
      close.current(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  const model = store.models.find((m) => m.id === store.selectedModelId);
  const efforts = effortsFor(model);
  // Runs through OpenRouter have no hosted web search, so the row stays in its unsupported state.
  const searchSupported = false;
  const enabledConnectors = store.connectors.filter((c) => c.enabled);
  const backToMain = React.useCallback(() => {
    setView('main');
    modelRow.current?.focus({ preventScroll: true });
  }, []);
  const openSheet = (sheet: 'connectors' | 'models') => {
    store.setPlusTrayOpen(false);
    store.setActiveSheet(sheet);
  };

  return (
    // Scale lives on this parent; opacity goes on the glass so its blur fades with it.
    <motion.div
      className={styles.anchor}
      initial={{ scale: pop.initial.scale }}
      animate={{ scale: 1 }}
      exit={{ scale: pop.exit.scale, transition: pop.exit.transition }}
      transition={pop.transition}
    >
      <GlassSurface
        ref={surface}
        radius={28}
        material="thick"
        role="dialog"
        aria-label="Composer options"
        tabIndex={-1}
        data-testid="plus-tray"
        className={styles.surface}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: pop.exit.transition }}
        transition={pop.transition}
      >
        <div className={styles.views} data-view={view}>
          <motion.div
            className={styles.main}
            initial={false}
            animate={view === 'models' ? under.animate : under.initial}
            transition={under.transition}
            inert={view === 'models'}
            aria-hidden={view === 'models' || undefined}
          >
            <SegmentedControl
              label="Mode"
              value={store.selectedMode}
              options={MODES}
              onChange={store.setSelectedMode}
              testIdPrefix="tray-mode"
            />
            <button
              ref={modelRow}
              type="button"
              className={styles.modelRow}
              data-testid="tray-model-picker-trigger"
              aria-haspopup="listbox"
              aria-expanded={view === 'models'}
              onClick={() => setView('models')}
            >
              <span className={styles.modelCopy}>
                <span className={styles.modelName}>{model?.name || 'Select model'}</span>
                <span className={styles.modelTagline}>{model ? modelDetail(model) : 'Choose a model for this chat'}</span>
              </span>
              <span className={styles.chevron}>
                <ChevronRight size={18} />
              </span>
            </button>
            {efforts.length > 0 ? (
              <div className={styles.effort}>
                <SegmentedControl
                  label="Reasoning effort"
                  value={store.selectedEffort}
                  options={efforts}
                  onChange={store.setSelectedEffort}
                />
                <p className={styles.detail}>
                  {EFFORT_DETAIL[store.selectedEffort] || 'Reasoning effort for this model.'}
                </p>
              </div>
            ) : null}
            <div className={styles.tiles}>
              {TILES.map(({ name, Icon, accept, capture }) => (
                <button
                  key={name}
                  type="button"
                  className={styles.tile}
                  data-testid={`tray-tile-${name.toLowerCase()}`}
                  onClick={() => onPickFiles(accept, capture)}
                >
                  <Icon size={20} />
                  <span>{name}</span>
                </button>
              ))}
            </div>
            <div className={styles.group}>
              <label className={styles.row}>
                <span className={styles.rowIcon}>
                  <Globe size={18} />
                </span>
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>Web search</span>
                  {!searchSupported ? (
                    <span className={styles.rowDetail}>Not supported by this model</span>
                  ) : null}
                </span>
                <Switch
                  label="Web search"
                  checked={store.webSearch && searchSupported}
                  disabled={!searchSupported}
                  onChange={store.setWebSearch}
                />
              </label>
              <button type="button" className={styles.row} onClick={() => openSheet('connectors')}>
                <span className={styles.rowIcon}>
                  <Link size={18} />
                </span>
                <span className={styles.rowCopy}>Connectors</span>
                <span className={styles.rowValue}>{enabledConnectors.length || 'None'}</span>
                <span className={styles.chevron}>
                  <ChevronRight size={16} />
                </span>
              </button>
              {store.activeChat
                ? enabledConnectors.map((connector) => (
                    <label key={connector.id} className={`${styles.row} ${styles.indent}`}>
                      <span className={styles.rowCopy}>
                        <span className={styles.rowTitle}>{connector.name}</span>
                      </span>
                      <Switch
                        label={connector.name}
                        checked={!store.activeChat!.disabledConnectorIds.includes(connector.id)}
                        onChange={(checked) =>
                          void store.toggleChatConnector(store.activeChat!.id, connector.id, checked)
                        }
                      />
                    </label>
                  ))
                : null}
              <button type="button" className={styles.row} onClick={() => openSheet('models')}>
                <span className={styles.rowIcon}>
                  <Settings size={18} />
                </span>
                <span className={styles.rowCopy}>Models & OpenRouter</span>
                <span className={styles.chevron}>
                  <ChevronRight size={16} />
                </span>
              </button>
            </div>
          </motion.div>
          <AnimatePresence initial={false}>
            {view === 'models' ? (
              <motion.div
                key="models"
                className={styles.models}
                initial={push.initial}
                animate={push.animate}
                exit={push.exit}
                transition={push.transition}
              >
                <ModelList
                  onBack={backToMain}
                  autoFocus={typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </GlassSurface>
    </motion.div>
  );
}
