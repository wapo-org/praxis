import React from 'react';
import { DotMeter, GlassDropdown, GlassSurface } from '@praxis/glass';
import { usePraxisStore } from '../../state/store';

export interface PlusTrayProps {
  onPickFiles: (accept?: string, capture?: boolean) => void;
}

export const PlusTray: React.FC<PlusTrayProps> = ({ onPickFiles }) => {
  const {
    plusTrayOpen,
    setPlusTrayOpen,
    models,
    providers,
    selectedProviderId,
    selectedModelId,
    selectedEffort,
    selectedMode,
    setSelectedModel,
    setSelectedEffort,
    setSelectedMode,
    toggleModelPin,
    connectors,
    activeChat,
    toggleChatConnector,
    setActiveSheet,
    inlineModelSearchActive,
    setInlineModelSearchActive,
  } = usePraxisStore();

  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);
  const [effortPickerOpen, setEffortPickerOpen] = React.useState(false);
  const [modelSearch, setModelSearch] = React.useState('');

  if (!plusTrayOpen) return null;

  const currentModel =
    models.find((m) => m.providerId === selectedProviderId && m.id === selectedModelId) ??
    models[0];

  const availableEfforts = currentModel?.reasoningEfforts?.length
    ? currentModel.reasoningEfforts
    : ['low', 'medium', 'high'];

  const filteredModels = models.filter((m) => {
    if (!modelSearch.trim()) return true;
    const q = modelSearch.toLowerCase();
    return (
      m.displayName.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      (m.tagline?.toLowerCase().includes(q) ?? false)
    );
  });
  const unpinnedModels = getUnpinnedModels(filteredModels);

  const pinnedModels = filteredModels.filter((m) => m.pinned || m.favorite);

  return (
    <GlassSurface
      material="regular"
      intensity="medium"
      radius={24}
      data-testid="plus-tray"
      style={{
        width: '100%',
        padding: 14,
        marginBottom: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {/* Top 3 Media Action Tiles: Camera, Photos, Files */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 8,
        }}
      >
        <button
          type="button"
          data-testid="tray-tile-camera"
          onClick={() => onPickFiles('image/*', true)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '12px 8px',
            borderRadius: 16,
            background: 'var(--paper-fill-1)',
            border: '0.5px solid var(--paper-hairline)',
            color: 'var(--paper-ink)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 18 }}>📷</span>
          <span>Camera</span>
        </button>

        <button
          type="button"
          data-testid="tray-tile-photos"
          onClick={() => onPickFiles('image/*')}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '12px 8px',
            borderRadius: 16,
            background: 'var(--paper-fill-1)',
            border: '0.5px solid var(--paper-hairline)',
            color: 'var(--paper-ink)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 18 }}>🖼️</span>
          <span>Photos</span>
        </button>

        <button
          type="button"
          data-testid="tray-tile-files"
          onClick={() => onPickFiles('*/*')}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '12px 8px',
            borderRadius: 16,
            background: 'var(--paper-fill-1)',
            border: '0.5px solid var(--paper-hairline)',
            color: 'var(--paper-ink)',
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 18 }}>📎</span>
          <span>Files</span>
        </button>
      </div>

      {/* Control Rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {/* Model Row with New GlassDropdown */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 14,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, color: 'var(--paper-ink-2)', fontWeight: 500 }}>
              Model
            </span>
            <button
              type="button"
              data-testid="tray-inline-model-search-toggle"
              onClick={() => setInlineModelSearchActive(!inlineModelSearchActive)}
              style={{
                padding: '2px 7px',
                borderRadius: 999,
                border: '0.5px solid var(--paper-hairline)',
                background: inlineModelSearchActive
                  ? 'var(--paper-accent)'
                  : 'var(--paper-fill-1)',
                color: inlineModelSearchActive ? '#FFFFFF' : 'var(--paper-ink-2)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {inlineModelSearchActive ? 'Inline search on' : 'Search in bar'}
            </button>
          </div>

          <GlassDropdown
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
            align="end"
            side="top"
          >
            <GlassDropdown.Trigger
              data-testid="tray-model-picker-trigger"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 11px',
                borderRadius: 10,
                border: '0.5px solid var(--paper-hairline)',
                background: 'var(--paper-fill-1)',
                color: 'var(--paper-ink)',
                fontSize: 13.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <span>{currentModel?.displayName ?? selectedModelId}</span>
            </GlassDropdown.Trigger>

            <GlassDropdown.Content minWidth={320} maxHeight={420}>
              <GlassDropdown.Search
                value={modelSearch}
                onValueChange={setModelSearch}
                placeholder="Search models..."
              />

              {pinnedModels.length > 0 && (
                <>
                  <GlassDropdown.Label>Pinned</GlassDropdown.Label>
                  {pinnedModels.map((m) => (
                    <GlassDropdown.Item
                      key={`pin-${m.providerId}-${m.id}`}
                      lines={2}
                      selected={m.providerId === selectedProviderId && m.id === selectedModelId}
                      subtitle={m.tagline ?? m.id}
                      onSelect={() => {
                        setSelectedModel(m.providerId, m.id);
                      }}
                      trailingAction={
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          {typeof m.speed === 'number' && (
                            <DotMeter value={m.speed} label={`Speed ${m.speed}`} />
                          )}
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={`Unpin ${m.displayName}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void toggleModelPin(m.providerId, m.id, false);
                            }}
                            style={{ cursor: 'pointer', color: 'var(--paper-warn)' }}
                          >
                            ★
                          </span>
                        </div>
                      }
                    >
                      {m.displayName}
                    </GlassDropdown.Item>
                  ))}
                  <GlassDropdown.Separator />
                </>
              )}

              <GlassDropdown.Label>All Models ({unpinnedModels.length})</GlassDropdown.Label>
              {unpinnedModels.length > 35 ? (
                <GlassDropdown.VirtualList
                  items={unpinnedModels}
                  itemHeight={58}
                  height={240}
                  renderItem={(m) => (
                    <GlassDropdown.Item
                      key={`${m.providerId}-${m.id}`}
                      lines={2}
                      selected={m.providerId === selectedProviderId && m.id === selectedModelId}
                      subtitle={
                        providers.find((p) => p.id === m.providerId)?.name ??
                        m.tagline ??
                        m.providerId
                      }
                      onSelect={() => setSelectedModel(m.providerId, m.id)}
                      trailingAction={
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleModelPin(m.providerId, m.id, !m.pinned);
                          }}
                          style={{
                            cursor: 'pointer',
                            color: m.pinned ? 'var(--paper-warn)' : 'var(--paper-ink-3)',
                          }}
                        >
                          {m.pinned ? '★' : '☆'}
                        </span>
                      }
                    >
                      {m.displayName}
                    </GlassDropdown.Item>
                  )}
                />
              ) : (
                unpinnedModels.map((m) => (
                  <GlassDropdown.Item
                    key={`${m.providerId}-${m.id}`}
                    lines={2}
                    selected={m.providerId === selectedProviderId && m.id === selectedModelId}
                    subtitle={m.tagline ?? m.providerId}
                    onSelect={() => setSelectedModel(m.providerId, m.id)}
                    trailingAction={
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {typeof m.intelligence === 'number' && (
                          <DotMeter value={m.intelligence} label={`Intelligence ${m.intelligence}`} />
                        )}
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleModelPin(m.providerId, m.id, !m.pinned);
                          }}
                          style={{
                            cursor: 'pointer',
                            color: m.pinned ? 'var(--paper-warn)' : 'var(--paper-ink-3)',
                          }}
                        >
                          {m.pinned ? '★' : '☆'}
                        </span>
                      </div>
                    }
                  >
                    {m.displayName}
                  </GlassDropdown.Item>
                ))
              )}
            </GlassDropdown.Content>
          </GlassDropdown>
        </div>

        {/* Reasoning Effort Row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 14,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
          }}
        >
          <span style={{ fontSize: 14, color: 'var(--paper-ink-2)', fontWeight: 500 }}>
            Reasoning effort
          </span>

          <GlassDropdown
            open={effortPickerOpen}
            onOpenChange={setEffortPickerOpen}
            align="end"
            side="top"
          >
            <GlassDropdown.Trigger
              data-testid="tray-effort-picker-trigger"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 11px',
                borderRadius: 10,
                border: '0.5px solid var(--paper-hairline)',
                background: 'var(--paper-fill-1)',
                color: 'var(--paper-ink)',
                fontSize: 13.5,
                fontWeight: 600,
                textTransform: 'capitalize',
                cursor: 'pointer',
              }}
            >
              <span>{selectedEffort}</span>
            </GlassDropdown.Trigger>

            <GlassDropdown.Content minWidth={200}>
              <GlassDropdown.Label>Reasoning Effort</GlassDropdown.Label>
              <GlassDropdown.RadioGroup
                value={selectedEffort}
                onValueChange={(val) => setSelectedEffort(val)}
              >
                {availableEfforts.map((eff) => (
                  <GlassDropdown.RadioItem key={eff} value={eff}>
                    <span style={{ textTransform: 'capitalize' }}>{eff}</span>
                  </GlassDropdown.RadioItem>
                ))}
              </GlassDropdown.RadioGroup>
            </GlassDropdown.Content>
          </GlassDropdown>
        </div>

        {/* Mode Segmented Row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderRadius: 14,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
          }}
        >
          <span style={{ fontSize: 14, color: 'var(--paper-ink-2)', fontWeight: 500 }}>Mode</span>
          <div
            style={{
              display: 'inline-flex',
              padding: 2,
              borderRadius: 10,
              background: 'var(--paper-fill-1)',
              gap: 2,
            }}
          >
            {(['ask', 'plan', 'build', 'auto'] as const).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`tray-mode-${m}`}
                onClick={() => setSelectedMode(m)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: selectedMode === m ? 'var(--paper-surface)' : 'transparent',
                  color: selectedMode === m ? 'var(--paper-ink)' : 'var(--paper-ink-2)',
                  fontSize: 12.5,
                  fontWeight: selectedMode === m ? 600 : 500,
                  textTransform: 'capitalize',
                  cursor: 'pointer',
                  boxShadow:
                    selectedMode === m ? '0 1px 4px rgba(18, 17, 15, 0.08)' : 'none',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Per-Chat Connectors Row */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 12px',
            borderRadius: 14,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13.5, color: 'var(--paper-ink-2)', fontWeight: 500 }}>
              Connectors ({connectors.length})
            </span>
            <button
              type="button"
              data-testid="tray-manage-connectors"
              onClick={() => {
                setPlusTrayOpen(false);
                setActiveSheet('connectors');
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--paper-accent)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Manage →
            </button>
          </div>

          {connectors.length > 0 && activeChat && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {connectors.map((conn) => {
                const isDisabledForChat =
                  activeChat.disabledConnectorIds?.includes(conn.id) ?? false;
                const activeInChat = conn.enabled && !isDisabledForChat;
                return (
                  <button
                    key={conn.id}
                    type="button"
                    data-testid={`tray-connector-toggle-${conn.id}`}
                    onClick={() =>
                      void toggleChatConnector(activeChat.id, conn.id, !activeInChat)
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 10px',
                      borderRadius: 999,
                      border: '0.5px solid var(--paper-hairline)',
                      background: activeInChat ? 'var(--paper-fill-1)' : 'transparent',
                      color: activeInChat ? 'var(--paper-ink)' : 'var(--paper-ink-3)',
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: activeInChat ? 'var(--paper-accent)' : 'var(--paper-ink-3)',
                      }}
                    />
                    <span>{conn.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </GlassSurface>
  );
};

export function getUnpinnedModels<T extends { pinned?: boolean; favorite?: boolean }>(models: T[]): T[] {
  return models.filter(m => !m.pinned && !m.favorite);
}
