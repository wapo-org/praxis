import { GlassChip, GlassSurface, GlassDropdown } from '@praxis/glass';
import React from 'react';
import { ArrowLeft, Moon, Shield, Sun } from '../../lib/icons';
import { PraxisStoreContext } from '../../state/context';
import styles from './GlassLabPage.module.css';
import { DropdownPositions } from './DropdownPositions';
import { MorphLab } from './MorphLab';

import { ScrimComparison } from './ScrimComparison';
import { VirtualModelPicker } from './VirtualModelPicker';

export interface GlassLabPageProps {
  onNavigateBack?: () => void;
}

export function GlassLabPage({ onNavigateBack }: GlassLabPageProps) {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    return 'light';
  });

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('praxis-theme', next);
      } catch {}
    }
  };

  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('dropdown'))
    return <DropdownPositions />;
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('morph'))
    return <MorphLab />;

  return (
    <div data-testid="glass-lab-page" className={styles.page}>
      <header className={`${styles.header} glass-lab-header`}>
        <GlassChip
          data-testid="glass-lab-back-button"
          icon={<ArrowLeft size={16} />}
          onClick={onNavigateBack}
        >
          Back to Chat
        </GlassChip>
        <h1>Liquid Glass</h1>
        <GlassChip
          data-testid="glass-lab-theme-toggle"
          icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
        </GlassChip>
        <ConsentDemoChip onNavigateBack={onNavigateBack} />
      </header>
      <main className={`${styles.main} glass-lab-main`}>
        <section className={styles.recipes} aria-label="Glass materials">
          {(['regular', 'thick', 'clear'] as const).map((material) => (
            <GlassSurface key={material} material={material} className={styles.recipe}>
              {material}
            </GlassSurface>
          ))}
        </section>
        <DropdownPositions compact />
        <section className={styles.card}>
          <h2>Menu motion</h2>
          <MotionPreview />
          <a href="/lab/glass?morph">Open motion playground</a>
        </section>
        <VirtualModelPicker />
        <ScrimComparison />
      </main>
    </div>
  );
}

/**
 * Dev-only: drive the real AI data-consent popover through real store state,
 * so the anchored popover (and its send-blocking) can be inspected live.
 */
function ConsentDemoChip({ onNavigateBack }: { onNavigateBack?: () => void }) {
  const store = React.useContext(PraxisStoreContext);
  if (!store) return null;
  return (
    <GlassChip
      data-testid="glass-lab-consent-demo"
      icon={<Shield size={16} />}
      onClick={() => {
        store.setPendingConsentPrompt({
          host: 'example.com',
          purpose: 'chat',
          description:
            'Allow Praxis to send conversation messages and attachments to Example (example.com)?',
          onAllow: () => store.setPendingConsentPrompt(null),
          onCancel: () => store.setPendingConsentPrompt(null),
        });
        onNavigateBack?.();
      }}
    >
      Consent popover
    </GlassChip>
  );
}

function MotionPreview() {
  return (
    <GlassDropdown portal submenuMode="morph">
      <GlassDropdown.Trigger data-testid="motion-preview-trigger">Actions</GlassDropdown.Trigger>
      <GlassDropdown.Content>
        <GlassDropdown.Item>Copy</GlassDropdown.Item>
        <GlassDropdown.Sub id="recent" label="Recent chats">
          <GlassDropdown.SubTrigger data-testid="recent-chats-subtrigger">
            Recent chats
          </GlassDropdown.SubTrigger>
          <GlassDropdown.SubContent>
            {[
              'Design review',
              'Release checklist',
              'Project plan',
              'Research notes',
              'Weekly summary',
            ].map((title) => (
              <GlassDropdown.Item key={title} lines={3}>
                {title} — Review the latest updates and next steps for this conversation.
              </GlassDropdown.Item>
            ))}
          </GlassDropdown.SubContent>
        </GlassDropdown.Sub>
      </GlassDropdown.Content>
    </GlassDropdown>
  );
}
