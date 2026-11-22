import { OpenRouterCard } from './OpenRouterCard';
import { SidebarLookControl } from './SidebarLookControl';
import { Eye, FlaskConical, Mic } from '../../lib/icons';
import { usePraxisStore } from '../../state/store.js';
import { SegmentedControl } from '../ui/controls';
import { AccountSettings } from './AccountSettings';
import styles from './Screen.module.css';
import {
  Card,
  NavRow,
  ScreenBody,
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
      <OpenRouterCard />
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
