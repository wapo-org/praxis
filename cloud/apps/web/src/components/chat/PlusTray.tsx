import { GlassMorph, ScrollBlur, slideIn, slideUnder, usePreset } from '@praxis/glass';
import { AnimatePresence, motion } from 'framer-motion';
import React from 'react';
import { ChevronRight, Globe, Link, Settings } from '../../lib/icons';
import { usePraxisStore } from '../../state/store';
import { SegmentedControl, Switch } from '../ui/controls';
import { RowGroup, rowClass } from '../ui/RowGroup';
import { ConnectorList } from './ConnectorList';
import { ModelList } from './ModelList';
import { ACTIONS, actionOptions, applyOption, ATTACHMENTS } from '../../actions/registry';
import styles from './PlusTray.module.css';

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
  const [view, setView] = React.useState<'main' | 'models' | 'connectors'>('main');
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
  const surface = React.useRef<HTMLDivElement>(null);
  const modelRow = React.useRef<HTMLButtonElement>(null);
  const connectorsRow = React.useRef<HTMLButtonElement>(null);
  const viewRef = React.useRef(view);
  viewRef.current = view;
  const close = React.useRef(store.setPlusTrayOpen);
  close.current = store.setPlusTrayOpen;

  const plusButton = () =>
    surface.current?.closest('[data-testid="composer-dock"]')?.querySelector<HTMLElement>('[data-testid="composer-plus-button"]') ?? null;

  React.useLayoutEffect(() => {
    const measure = () => {
      const rect = plusButton()?.getBoundingClientRect();
      if (!rect || rect.top <= 0) {
        setMaxHeight(undefined);
        return;
      }
      setMaxHeight(Math.max(160, Math.min(480, Math.floor(rect.top - 16))));
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, []);

  const backToMain = React.useCallback((target: 'models' | 'connectors') => {
    setView('main');
    (target === 'connectors' ? connectorsRow.current : modelRow.current)?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    surface.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (viewRef.current === 'models') {
        backToMain('models');
      } else if (viewRef.current === 'connectors') {
        backToMain('connectors');
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
  }, [backToMain]);

  const model = store.models.find(
    (m) => m.id === store.selectedModelId,
  );
  const modes = actionOptions('mode', store);
  const efforts = actionOptions('effort', store);
  const webChat = store.activeChat;
  const webToolsOn = webChat?.webToolsEnabled !== false;
  const enabledConnectors = store.connectors.filter((c) => c.enabled);
  const inSubView = view !== 'main';
  const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  const openSheet = (sheet: 'connectors' | 'models') => {
    store.setPlusTrayOpen(false);
    store.setActiveSheet(sheet);
  };

  return (
    <GlassMorph
      source={plusButton}
      material="thick"
      shellProps={{
        className: styles.anchor,
        style: maxHeight !== undefined ? ({ '--tray-max-height': `${maxHeight}px` } as React.CSSProperties) : undefined,
      }}
      surfaceRef={surface}
      role="dialog"
      aria-label="Composer options"
      tabIndex={-1}
      data-testid="plus-tray"
      className={styles.surface}
    >
      <div className={styles.views} data-view={view}>
        <motion.div
          className={styles.mainMotion}
          initial={false}
          animate={inSubView ? under.animate : under.initial}
          transition={under.transition}
          inert={inSubView}
          aria-hidden={inSubView || undefined}
        >
          <ScrollBlur className={styles.mainScroll} maxHeight="var(--tray-limit)" scrimHeight={16}>
            <div className={styles.main}>
              <SegmentedControl
                label="Mode"
                value={store.selectedMode}
                options={modes.map((o) => o.id as typeof store.selectedMode)}
                optionLabel={(id) => modes.find((o) => o.id === id)?.label ?? id}
                onChange={(id) => applyOption('mode', store, id)}
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
                    options={efforts.map((o) => o.id)}
                    optionLabel={(id) => efforts.find((o) => o.id === id)?.label ?? id}
                    onChange={(id) => applyOption('effort', store, id)}
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
                <label className={`${rowClass(!!webChat)} ${styles.row}`}>
                  <span className={styles.rowIcon}>
                    <Globe size={18} />
                  </span>
                  <span className={styles.rowCopy}>
                    <span className={styles.rowTitle}>{ACTIONS.web.label}</span>
                    <span className={styles.rowDetail}>
                      {webChat ? 'Search and read the web in this chat' : 'Available once the chat starts'}
                    </span>
                  </span>
                  <Switch
                    label="Web tools"
                    checked={webToolsOn}
                    disabled={!webChat}
                    onChange={(enabled) => { if (webChat) void store.setChatWebTools(webChat.id, enabled); }}
                  />
                </label>
                <button
                  ref={connectorsRow}
                  type="button"
                  className={`${rowClass(true)} ${styles.row}`}
                  data-testid="tray-connectors-trigger"
                  aria-haspopup="dialog"
                  aria-expanded={view === 'connectors'}
                  onClick={() => setView('connectors')}
                >
                  <span className={styles.rowIcon}>
                    <Link size={18} />
                  </span>
                  <span className={styles.rowCopy}>{ACTIONS.connectors.label}</span>
                  <span className={styles.rowValue}>
                    {enabledConnectors.length > 0 ? `· ${enabledConnectors.length}` : 'None'}
                  </span>
                  <span className={styles.chevron}>
                    <ChevronRight size={16} />
                  </span>
                </button>
                <button
                  type="button"
                  className={`${rowClass(true)} ${styles.row}`}
                  onClick={() => openSheet('models')}
                >
                  <span className={styles.rowIcon}>
                    <Settings size={18} />
                  </span>
                  <span className={styles.rowCopy}>{ACTIONS.providers.label}</span>
                  <span className={styles.chevron}>
                    <ChevronRight size={16} />
                  </span>
                </button>
              </RowGroup>
            </div>
          </ScrollBlur>
        </motion.div>
        <AnimatePresence initial={false}>
          {view === 'models' ? (
            <motion.div
              key="models"
              className={styles.subView}
              initial={push.initial}
              animate={push.animate}
              exit={push.exit}
              transition={push.transition}
            >
              <ModelList onBack={() => backToMain('models')} autoFocus={!coarsePointer} />
            </motion.div>
          ) : view === 'connectors' ? (
            <motion.div
              key="connectors"
              className={styles.subView}
              initial={push.initial}
              animate={push.animate}
              exit={push.exit}
              transition={push.transition}
            >
              <ConnectorList
                onBack={() => backToMain('connectors')}
                onOpenSettings={() => openSheet('connectors')}
                autoFocus={!coarsePointer}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </GlassMorph>
  );
}
