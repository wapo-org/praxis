import { GlassMorph, slideIn, slideUnder, usePreset } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { ChevronRight, Globe, Link, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { SegmentedControl, Switch } from '../ui/controls';
import { RowGroup, rowClass } from '../ui/RowGroup';
import { ModelList } from './ModelList';
import { ACTIONS, actionOptions, applyOption, ATTACHMENTS } from '../../actions/registry';
import styles from './PlusTray.module.css';

export { getUnpinnedModels } from './ModelList';
export interface PlusTrayProps {
  onPickFiles: (accept?: string, capture?: boolean) => void;
}


export function PlusTray({ onPickFiles }: PlusTrayProps) {
  const open = usePraxisStore().plusTrayOpen;
  return <AnimatePresence>{open ? <TrayPopover key="tray" onPickFiles={onPickFiles} /> : null}</AnimatePresence>;
}

function TrayPopover({ onPickFiles }: PlusTrayProps) {
  const store = usePraxisStore();
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
    surface.current?.closest('[data-testid="composer-dock"]')?.querySelector<HTMLElement>('[data-testid="composer-plus-button"]') ?? null;

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

  const model = store.models.find(
    (m) => m.providerId === store.selectedProviderId && m.id === store.selectedModelId,
  );
  const modes = actionOptions('mode', store);
  const efforts = actionOptions('effort', store);
  const searchSupported = !!model?.capabilities.serverWebSearch;
  const enabledConnectors = store.connectors.filter((c) => c.enabled);
  const backToMain = React.useCallback(() => {
    setView('main');
    modelRow.current?.focus({ preventScroll: true });
  }, []);
  const openSheet = (sheet: 'connectors' | 'providers') => {
    store.setPlusTrayOpen(false);
    store.setActiveSheet(sheet);
  };

  return (
    <GlassMorph
      source={plusButton}
      material="thick"
      shellProps={{ className: styles.anchor }}
      surfaceRef={surface}
      role="dialog"
      aria-label="Composer options"
      tabIndex={-1}
      data-testid="plus-tray"
      className={styles.surface}
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
              options={modes.map(o => o.id as typeof store.selectedMode)}
              optionLabel={id => modes.find(o => o.id === id)?.label ?? id}
              onChange={id => applyOption('mode', store, id)}
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
                <span className={styles.modelName}>{model?.displayName || 'Select model'}</span>
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
                  options={efforts.map(o => o.id)}
                  optionLabel={id => efforts.find(o => o.id === id)?.label ?? id}
                  onChange={id => applyOption('effort', store, id)}
                />

              </div>
            ) : null}
            <div className={styles.tiles}>
              {ATTACHMENTS.map(({ name, Icon, accept, capture }) => (
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
            <RowGroup>
              <label className={`${rowClass(searchSupported)} ${styles.row}`}>
                <span className={styles.rowIcon}>
                  <Globe size={18} />
                </span>
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{ACTIONS.web.label}</span>
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
              <button type="button" className={`${rowClass(true)} ${styles.row}`} onClick={() => openSheet('connectors')}>
                <span className={styles.rowIcon}>
                  <Link size={18} />
                </span>
                <span className={styles.rowCopy}>{ACTIONS.connectors.label}</span>
                <span className={styles.rowValue}>{enabledConnectors.length || 'None'}</span>
                <span className={styles.chevron}>
                  <ChevronRight size={16} />
                </span>
              </button>
              {enabledConnectors.map((connector) => (
                    <label key={connector.id} className={`${rowClass(!!store.activeChat)} ${styles.row} ${styles.indent}`}>
                      <span className={styles.rowCopy}>
                        <span className={styles.rowTitle}>{connector.name}</span>
                      </span>
                      <Switch
                        label={connector.name}
                        checked={!store.activeChat?.disabledConnectorIds.includes(connector.id)}
                        disabled={!store.activeChat}
                        onChange={(checked) =>
                          void store.toggleChatConnector(store.activeChat!.id, connector.id, checked)
                        }
                      />
                    </label>
                  ))}
              <button type="button" className={`${rowClass(true)} ${styles.row}`} onClick={() => openSheet('providers')}>
                <span className={styles.rowIcon}>
                  <Settings size={18} />
                </span>
                <span className={styles.rowCopy}>{ACTIONS.providers.label}</span>
                <span className={styles.chevron}>
                  <ChevronRight size={16} />
                </span>
              </button>
            </RowGroup>
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
    </GlassMorph>
  );
}
