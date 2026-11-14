import { SidebarLookControl } from './SidebarLookControl';
import { Eye, FlaskConical, Mic, Plus } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import { SegmentedControl } from '../ui/controls';
import { AccountSettings } from './AccountSettings';
import styles from './Screen.module.css';
import {
  Card,
  hostLabel,
  NavRow,
  ScreenBody,
  ScreenButton,
  Section,
  TaskError,
  Toggle,
  useScreenTask,
} from './ScreenUI.js';

const THEMES = ['light', 'dark', 'system'] as const;
const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function GeneralSection() {
  const store = usePraxisStore();
  return (
    <ScreenBody>
      <Section title="Appearance">
        <SegmentedControl
          label="Appearance"
          value={store.themeMode}
          options={THEMES}
          optionLabel={capitalized}
          onChange={store.setThemeMode}
        />
        <SidebarLookControl />
      </Section>
      <Section title="Input">
        <Card>
          <NavRow
            icon={<Mic size={18} />}
            title="Voice input"
            value={store.preferences?.voice.configured ? 'Configured' : 'Set up'}
            onClick={() => store.setActiveSheet('voice-settings')}
          />
        </Card>
      </Section>
    </ScreenBody>
  );
}

export function ModelsSection() {
  const store = usePraxisStore();
  return (
    <ScreenBody>
      <Section title="Providers">
        {store.providers.length ? (
          <Card>
            {store.providers.map((provider) => (
              <NavRow
                key={provider.id}
                title={provider.name}
                detail={`${hostLabel(provider.baseUrl)} · ${provider.maskedKey || 'No API key'}`}
                value={
                  <span
                    className={`${styles.badge} ${provider.maskedKey ? styles.badgeSuccess : ''}`}
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
          <p className={styles.intro}>
            You’re chatting with the built-in demo. Add a provider with your own API key, or a
            server on your network, to chat with a real model.
          </p>
        )}
        <ScreenButton
          tone="primary"
          onClick={() => {
            store.setEditingProviderId(null);
            store.setActiveSheet('provider-editor');
          }}
        >
          <Plus size={16} />
          Add provider
        </ScreenButton>
        <p className={styles.footnote}>API keys are write-only. A saved key is never shown here.</p>
      </Section>
      <Section title="Tools">
        <Card>
          <NavRow
            icon={<Eye size={18} />}
            title="Image reading model"
            value={
              store.preferences?.vision.enabled && store.preferences.vision.modelId
                ? store.preferences.vision.modelId
                : 'Off'
            }
            onClick={() => store.setActiveSheet('image-reader')}
          />
        </Card>
      </Section>
    </ScreenBody>
  );
}

export function AccountSection() {
  return (
    <ScreenBody>
      <AccountSettings />
    </ScreenBody>
  );
}

export function ConsentsSection() {
  const { consents, grantConsent } = usePraxisStore();
  const task = useScreenTask();
  return (
    <ScreenBody>
      <p className={styles.intro}>
        Praxis asks before it first sends data to a service. Withdraw permission here to be asked
        again before sending.
      </p>
      <TaskError error={task.error} />
      <Section title="Data consents">
        {consents.length ? (
          <Card>
            {consents.map((consent) => (
              <Toggle
                key={consent.host}
                label={consent.host}
                detail={consent.allowed ? 'Allowed to receive data' : 'Permission withdrawn'}
                checked={consent.allowed}
                disabled={task.busy}
                onChange={(allowed) => {
                  void task.run(() => grantConsent(consent.host, allowed));
                }}
              />
            ))}
          </Card>
        ) : (
          <p className={styles.empty}>No services have been granted permission yet.</p>
        )}
      </Section>
    </ScreenBody>
  );
}

export function DeveloperSection({ onOpenGlassLab }: { onOpenGlassLab?: () => void }) {
  const store = usePraxisStore();
  return (
    <ScreenBody>
      <Section title="Tools" hint="Development builds only.">
        <Card>
          <NavRow
            icon={<FlaskConical size={18} />}
            title="Liquid Glass Lab"
            onClick={() => {
              store.setActiveSheet(null);
              onOpenGlassLab?.();
            }}
          />
        </Card>
      </Section>
    </ScreenBody>
  );
}
