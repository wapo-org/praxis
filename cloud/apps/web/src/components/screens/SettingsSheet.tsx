import React from 'react';
import {
  Eye,
  FlaskConical,
  Link,
  Mic,
  Plus,
  Shield,
  Sparkles,
  Trash2,
} from '../../lib/icons';
import { GlassChip } from '@praxis/glass';
import type { Provider } from '@praxis/protocol';
import { usePraxisStore } from '../../state/store.js';
import { apiClient } from '../../lib/api.js';
import {
  Card,
  Field,
  hostLabel,
  NavRow,
  requireHttpUrl,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  useScreenTask,
} from './ScreenUI.js';

export function SettingsSheet({
  onOpenGlassLab,
}: {
  onOpenGlassLab?: () => void;
}) {
  const store = usePraxisStore();
  return (
    <ScreenBody>
      <Section title="Model providers">
        {store.providers.length ? (
          <Card>
            {store.providers.map((provider) => (
              <NavRow
                key={provider.id}
                title={provider.name}
                detail={`${hostLabel(provider.baseUrl)} · ${provider.maskedKey || 'No API key'}`}
                value={
                  <span
                    className={`screen-badge${provider.maskedKey ? ' screen-badge--success' : ''}`}
                  >
                    {provider.id === 'scripted'
                      ? 'Demo'
                      : provider.maskedKey
                        ? 'Configured'
                        : 'Missing key'}
                  </span>
                }
                onClick={() => {
                  store.setEditingProviderId(provider.id);
                  store.setActiveSheet('provider-editor');
                }}
              />
            ))}
          </Card>
        ) : (
          <p className="screen-intro">
            You’re chatting with the built-in demo. Add a provider with your own
            API key, or a server on your network, to chat with a real model.
          </p>
        )}
        <ScreenButton
          tone="primary"
          onClick={() => {
            store.setEditingProviderId(null);
            store.setActiveSheet('provider-editor');
          }}
        >
          <Plus size={17} />
          Add provider
        </ScreenButton>
        <p className="screen-footnote">
          API keys are write-only. A saved key is never shown here.
        </p>
      </Section>
      <Section title="Tools">
        <Card>
          <NavRow
            icon={<Link size={18} />}
            title="Connectors"
            value={store.connectors.length || 'None'}
            onClick={() => store.setActiveSheet('connectors')}
          />
          <NavRow
            icon={<Sparkles size={18} />}
            title="Skills"
            value={store.skills.length || 'None'}
            onClick={() => store.setActiveSheet('skills')}
          />
        </Card>
      </Section>
      <Section title="AI data sharing">
        <p className="screen-intro">Praxis asks before it first sends a chat to a provider. Providers you allow show up here. You can withdraw sharing at any time.</p>
        <Card>
          <NavRow
            icon={<Eye size={18} />}
            title="Image reading model"
            value={
              store.preferences?.vision.enabled &&
              store.preferences.vision.modelId
                ? store.preferences.vision.modelId
                : 'Off'
            }
            onClick={() => store.setActiveSheet('image-reader')}
          />
          <NavRow
            icon={<Mic size={18} />}
            title="Voice input"
            value={
              store.preferences?.voice.configured ? 'Configured' : 'Set up'
            }
            onClick={() => store.setActiveSheet('voice-settings')}
          />
          <NavRow
            icon={<Shield size={18} />}
            title="Data consents"
            value={store.consents.filter((consent) => consent.allowed).length}
            onClick={() => store.setActiveSheet('consents')}
          />
        </Card>
      </Section>
      <Section title="Appearance">
        <div className="screen-pill-row" role="group" aria-label="Appearance">
          {(['light', 'dark', 'system'] as const).map((mode) => (
            <GlassChip
              key={mode}
              active={store.themeMode === mode}
              aria-pressed={store.themeMode === mode}
              onClick={() => store.setThemeMode(mode)}
            >
              {mode.charAt(0).toUpperCase() + mode.slice(1)}
            </GlassChip>
          ))}
        </div>
      </Section>
      {import.meta.env.DEV && onOpenGlassLab ? (
        <ScreenButton
          onClick={() => {
            store.setActiveSheet(null);
            onOpenGlassLab();
          }}
        >
          <FlaskConical size={17} />
          Open Liquid Glass Lab
        </ScreenButton>
      ) : null}
    </ScreenBody>
  );
}

export { ProviderEditor } from './ProviderEditor';
