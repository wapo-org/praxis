import { GlassChip } from '@praxis/glass';
import React from 'react';
import { ArrowLeft, Moon, Shield, Sun } from '../../lib/icons';
import { PraxisStoreContext } from '../../state/context';
import { AppleNotesReplica } from './AppleNotesReplica';
import { DropdownPositions } from './DropdownPositions';
import { MorphLab } from './MorphLab';
import './lab.css';
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
    <div
      data-testid="glass-lab-page"
      style={{
        width: '100vw',
        height: '100dvh',
        overflowY: 'auto',
        backgroundColor: 'var(--paper-canvas)',
        color: 'var(--paper-ink)',
        fontFamily: 'var(--font-sans)',
        paddingBottom: '80px',
      }}
    >
      {/* Top Sticky Floating Header */}
      <header
        className="glass-lab-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 90,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          padding: '14px 24px',
          borderBottom: '1px solid var(--paper-hairline)',
          backgroundColor: 'color-mix(in srgb, var(--paper-canvas) 82%, transparent)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <GlassChip
            data-testid="glass-lab-back-button"
            icon={<ArrowLeft size={16} />}
            onClick={() => onNavigateBack?.()}
          >
            Back to Chat
          </GlassChip>
          <div>
            <h1
              style={{
                margin: 0,
                fontFamily: 'var(--font-serif)',
                fontSize: 'var(--text-xl)',
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              Liquid Glass Optical Lab
            </h1>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--paper-secondary-ink)' }}>
              @praxis/glass · Snell Squircle Refraction &amp; 35-Frame UIMenu Physics
            </div>
          </div>
        </div>

        {/* Theme switcher */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >

          <GlassChip
            data-testid="glass-lab-theme-toggle"
            icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </GlassChip>
          {/* Dev-only demo: drive the real ConsentPopover through real store state. */}
          <ConsentDemoChip onNavigateBack={onNavigateBack} />
        </div>
      </header>

      <main
        className="glass-lab-main"
        style={{
          maxWidth: '1240px',
          margin: '0 auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '28px',
        }}
      >

        <DropdownPositions compact />
        {/* Two-column showcase: Apple Notes 35-Frame Replica & 500-Model Virtualized Picker */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))',
            gap: '24px',
            alignItems: 'start',
          }}
        >
          {/* 2. Apple Notes 35-Frame Reference Replica Dropdown (IMG_7744 – IMG_7778) */}
          <AppleNotesReplica />

          {/* 3. 500-Model Virtualized Picker Demo */}
          <VirtualModelPicker />
        </div>


        {/* 4. ProgressiveBlurScrim Scroll Container Demo (Side-by-Side Comparison) */}
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
          description: 'Allow Praxis to send conversation messages and attachments to Example (example.com)?',
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
