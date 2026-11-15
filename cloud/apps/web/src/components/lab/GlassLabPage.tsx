import { GlassChip } from '@praxis/glass';
import React from 'react';
import { ArrowLeft, Moon, Sun } from '../../lib/icons';
import { AppleNotesReplica } from './AppleNotesReplica';
import { DropdownPositions } from './DropdownPositions';
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
                fontSize: '20px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
              }}
            >
              Liquid Glass Optical Lab
            </h1>
            <div style={{ fontSize: '12px', color: 'var(--paper-secondary-ink)' }}>
              @praxis/glass · Snell Squircle Refraction &amp; 35-Frame UIMenu Physics
            </div>
          </div>
        </div>

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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 460px), 1fr))',
            gap: '24px',
            alignItems: 'start',
          }}
        >
          <AppleNotesReplica />

          <VirtualModelPicker />
        </div>

        <ScrimComparison />
      </main>
    </div>
  );
}
