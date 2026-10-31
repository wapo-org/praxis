import { GlassChip, useGlassMaterial, useGlassRuntime, type GlassStrategy } from '@praxis/glass';
import React from 'react';
import { ArrowLeft, Moon, Sun } from '../../lib/icons';
import { AppleNotesReplica } from './AppleNotesReplica';
import { DropdownPositions } from './DropdownPositions';
import './lab.css';
import { MaterialControls } from './MaterialControls';
import { ScrimComparison } from './ScrimComparison';
import { VirtualModelPicker } from './VirtualModelPicker';

export interface GlassLabPageProps {
  onNavigateBack?: () => void;
}

export function GlassLabPage({ onNavigateBack }: GlassLabPageProps) {
  const { strategy: contextStrategy } = useGlassMaterial();
  const runtimeStrategy = useGlassRuntime((s) => s.strategy);
  const setRuntimeStrategy = useGlassRuntime((s) => s.setStrategy);

  const activeStrategy: GlassStrategy = runtimeStrategy || contextStrategy;

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
            icon={<ArrowLeft size={14} />}
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

        {/* Engine Strategy Badge & Theme Switcher */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            flexWrap: 'wrap',
          }}
        >
          <div
            data-testid="glass-lab-strategy-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '5px 11px',
              borderRadius: '9999px',
              backgroundColor: 'var(--paper-fill-1)',
              border: '1px solid var(--paper-hairline)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              fontWeight: 500,
              color: 'var(--paper-ink)',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '9999px',
                backgroundColor:
                  activeStrategy === 'svg-displacement'
                    ? 'var(--paper-success)'
                    : activeStrategy === 'progressive-frost'
                      ? '#D97706'
                      : 'var(--paper-muted-ink)',
              }}
            />
            <span>Engine: {activeStrategy}</span>
          </div>

          <div
            role="group"
            aria-label="Simulate glass engine strategy"
            style={{
              display: 'inline-flex',
              padding: '2px',
              borderRadius: '9999px',
              backgroundColor: 'var(--paper-fill-1)',
              border: '1px solid var(--paper-hairline)',
            }}
          >
            {(
              ['svg-displacement', 'progressive-frost', 'reduced-transparency'] as GlassStrategy[]
            ).map((strat) => (
              <button
                key={strat}
                type="button"
                onClick={() => setRuntimeStrategy(strat)}
                style={{
                  border: 'none',
                  borderRadius: '9999px',
                  padding: '4px 9px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  cursor: 'pointer',
                  backgroundColor: activeStrategy === strat ? 'var(--paper-tile)' : 'transparent',
                  color:
                    activeStrategy === strat
                      ? 'var(--paper-tile-glyph)'
                      : 'var(--paper-secondary-ink)',
                }}
              >
                {strat === 'svg-displacement'
                  ? 'SVG'
                  : strat === 'progressive-frost'
                    ? 'Frost'
                    : 'Opaque'}
              </button>
            ))}
          </div>

          <GlassChip
            data-testid="glass-lab-theme-toggle"
            icon={theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
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
        {/* 1. Live Material Controls Panel */}
        <MaterialControls />

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
